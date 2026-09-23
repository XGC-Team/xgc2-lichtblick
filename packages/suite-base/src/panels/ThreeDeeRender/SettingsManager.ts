// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import EventEmitter from "eventemitter3";

import { SettingsTreeAction, SettingsTreeNode, SettingsTreeNodes } from "@lichtblick/suite";

import { LayerErrors, Path } from "./LayerErrors";

export type ActionHandler = (action: SettingsTreeAction) => void;

export type SettingsTreeNodeWithActionHandler = SettingsTreeNode & { handler?: ActionHandler };

export type SettingsTreeEntry = { path: Path; node: SettingsTreeNodeWithActionHandler };

export type SettingsManagerEvents = {
  update: () => void;
};

type NodeValidator = (entry: SettingsTreeEntry, errorState: LayerErrors) => void;

export class SettingsManager extends EventEmitter<SettingsManagerEvents> {
  public errors = new LayerErrors();

  #nodesByKey = new Map<string, SettingsTreeEntry[]>();
  #root: SettingsTreeNodeWithActionHandler = { children: {} };

  #globalSettingsEntryValidators: NodeValidator[] = [];

  public constructor(baseTree: SettingsTreeNodes) {
    super();

    this.#root = { children: baseTree };
    this.errors.on("update", this.handleErrorUpdate);
    this.errors.on("remove", this.handleErrorUpdate);
    this.errors.on("clear", this.handleErrorUpdate);
  }

  public setNodesForKey(key: string, nodes: SettingsTreeEntry[]): void {
    nodes.forEach((entry) => {
      this.#globalSettingsEntryValidators.forEach((validator) => {
        validator(entry, this.errors);
      });
    });

    // Every update copies only the ancestors on each changed path, so unchanged subtrees stay
    // shared between trees. The inserted nodes are built fresh by the caller; there is nothing to
    // gain from walking them (an immer draft re-walked every one on finalize — a node per
    // coordinate frame, twice a second for each 3D panel).
    let root = this.#root;
    // Delete all previous nodes for this key
    for (const { path } of this.#nodesByKey.get(key) ?? []) {
      root = withoutNodeAtPath(root, path, 0);
    }
    // Add the new nodes
    for (const { path, node } of nodes) {
      node.error ??= this.errors.errors.errorAtPath(path);
      node.label ??= path[path.length - 1];
      node.defaultExpansionState ??= "collapsed";
      if (path.length === 0) {
        throw new Error(`Empty path for settings node "${node.label}"`);
      }
      root = withNodeAtPath(root, path, 0, node);
    }
    this.#root = root;

    // Update the map of nodes by key
    this.#nodesByKey.set(key, nodes);

    this.emit("update");
  }

  public setLabel(path: Path, label: string): void {
    if (path.length === 0) {
      throw new Error(`Empty path for settings label "${label}"`);
    }
    this.#root = withLabelAtPath(this.#root, path, 0, label);

    this.emit("update");
  }

  public clearChildren(path: Path): void {
    this.#root = withoutChildrenAtPath(this.#root, path, 0);

    this.emit("update");
  }

  public tree(): SettingsTreeNodes {
    return this.#root.children!;
  }

  public handleAction = (action: SettingsTreeAction): void => {
    const path = action.payload.path;

    // Walk the settings tree down to the end of the path, firing any action
    // handlers along the way
    let curNode = this.#root;
    curNode.handler?.(action);
    for (const segment of path) {
      const nextNode: SettingsTreeNodeWithActionHandler | undefined = curNode.children?.[segment];
      if (!nextNode) {
        return;
      }
      nextNode.handler?.(action);
      curNode = nextNode;
    }
  };

  /** Add Validator function that can run over nodes `set` on the tree and update error state accordingly */
  public addNodeValidator = (nodeValidator: NodeValidator): void => {
    this.#globalSettingsEntryValidators.push(nodeValidator);
  };

  public removeNodeValidator = (nodeValidator: NodeValidator): void => {
    this.#globalSettingsEntryValidators = this.#globalSettingsEntryValidators.filter(
      (v) => v !== nodeValidator,
    );
  };

  public handleErrorUpdate = (path: Path): void => {
    this.#root =
      path.length === 0
        ? { ...this.#root }
        : withErrorAtPath(this.#root, path, 0, () => this.errors.errors.errorAtPath(path));

    this.emit("update");
  };
}

type Node = SettingsTreeNodeWithActionHandler;

/** `root` with `node` at `path`, creating missing ancestors. */
function withNodeAtPath(root: Node, path: Path, depth: number, node: Node): Node {
  const segment = path[depth]!;
  const next =
    depth === path.length - 1
      ? node
      : withNodeAtPath(root.children?.[segment] ?? {}, path, depth + 1, node);
  return { ...root, children: { ...root.children, [segment]: next } };
}

/** `root` with the node at `path` emptied; its key remains with an undefined value. */
function withoutNodeAtPath(root: Node, path: Path, depth: number): Node {
  if (depth >= path.length) {
    return root;
  }
  const segment = path[depth]!;
  const child = root.children?.[segment];
  if (!child) {
    return root;
  }
  const next = depth === path.length - 1 ? undefined : withoutNodeAtPath(child, path, depth + 1);
  return next === child ? root : { ...root, children: { ...root.children, [segment]: next } };
}

/** `root` with the children of the node at `path` removed, if that node exists. */
function withoutChildrenAtPath(root: Node, path: Path, depth: number): Node {
  if (depth >= path.length) {
    return root;
  }
  const segment = path[depth]!;
  const child = root.children?.[segment];
  if (!child) {
    return root;
  }
  const next =
    depth === path.length - 1
      ? { ...child, children: undefined }
      : withoutChildrenAtPath(child, path, depth + 1);
  return next === child ? root : { ...root, children: { ...root.children, [segment]: next } };
}

/** `root` with `label` on the node at `path`, creating missing nodes. */
function withLabelAtPath(root: Node, path: Path, depth: number, label: string): Node {
  if (depth === path.length) {
    return { ...root, label };
  }
  const segment = path[depth]!;
  const next = withLabelAtPath(root.children?.[segment] ?? {}, path, depth + 1, label);
  return { ...root, children: { ...root.children, [segment]: next } };
}

/**
 * `root` with the current error on the node at `path`. When the path has no node yet, only the
 * existing ancestors are copied so observers still see a new tree.
 */
function withErrorAtPath(
  root: Node,
  path: Path,
  depth: number,
  error: () => string | undefined,
): Node {
  if (depth === path.length) {
    return { ...root, error: error() };
  }
  const segment = path[depth]!;
  const child = root.children?.[segment];
  const next = child ? withErrorAtPath(child, path, depth + 1, error) : undefined;
  return {
    ...root,
    children: next ? { ...root.children, [segment]: next } : { ...root.children },
  };
}
