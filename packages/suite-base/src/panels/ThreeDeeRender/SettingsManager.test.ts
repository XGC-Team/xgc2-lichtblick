// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { SettingsManager, SettingsTreeEntry } from "./SettingsManager";

const baseTree = () => ({
  general: { label: "Frame" },
  scene: { label: "Scene" },
});

describe("SettingsManager", () => {
  afterEach(() => {
    // LayerErrors logs every added error.
    (console.warn as jest.Mock).mockClear();
  });

  it("adds entries with defaults and emits an update", () => {
    const manager = new SettingsManager(baseTree());
    manager.errors.add(["layers", "grid"], "bad", "Invalid grid");
    const update = jest.fn();
    manager.on("update", update);

    manager.setNodesForKey("grid", [{ path: ["layers", "grid"], node: { order: 1 } }]);

    const node = manager.tree().layers?.children?.grid;
    expect(node).toEqual({
      order: 1,
      label: "grid",
      defaultExpansionState: "collapsed",
      error: "Invalid grid",
    });
    // Intermediate nodes on the path are created as needed.
    expect(manager.tree().layers).toEqual({ children: { grid: node } });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit labels, expansion states and errors", () => {
    const manager = new SettingsManager(baseTree());
    manager.setNodesForKey("topics", [
      {
        path: ["topics"],
        node: { label: "Topics", defaultExpansionState: "expanded", error: "Own error" },
      },
    ]);
    expect(manager.tree().topics).toEqual({
      label: "Topics",
      defaultExpansionState: "expanded",
      error: "Own error",
    });
  });

  it("replaces a key's previous nodes and leaves an emptied slot", () => {
    const manager = new SettingsManager(baseTree());
    manager.setNodesForKey("frames", [
      { path: ["transforms", "frame:a"], node: { label: "a" } },
      { path: ["transforms", "frame:b"], node: { label: "b" } },
    ]);
    manager.setNodesForKey("frames", [{ path: ["transforms", "frame:c"], node: { label: "c" } }]);

    const children = manager.tree().transforms?.children ?? {};
    expect(Object.keys(children).sort()).toEqual(["frame:a", "frame:b", "frame:c"]);
    expect(children["frame:a"]).toBeUndefined();
    expect(children["frame:b"]).toBeUndefined();
    expect(children["frame:c"]?.label).toBe("c");
  });

  it("does not touch other keys' subtrees or earlier tree objects", () => {
    const manager = new SettingsManager(baseTree());
    manager.setNodesForKey("grid", [{ path: ["layers", "grid"], node: { label: "Grid" } }]);
    manager.setNodesForKey("frames", [{ path: ["transforms"], node: { label: "Transforms" } }]);
    const before = manager.tree();
    const beforeLayers = before.layers;
    const beforeTransforms = before.transforms;
    const beforeGeneral = before.general;

    manager.setNodesForKey("frames", [{ path: ["transforms"], node: { label: "Transforms 2" } }]);

    const after = manager.tree();
    expect(after).not.toBe(before);
    expect(after.layers).toBe(beforeLayers);
    expect(after.general).toBe(beforeGeneral);
    expect(after.transforms?.label).toBe("Transforms 2");
    // The previously returned tree is a snapshot and is not modified in place.
    expect(before.transforms).toBe(beforeTransforms);
    expect(before.transforms?.label).toBe("Transforms");
  });

  it("dispatches actions to handlers along the path", () => {
    const manager = new SettingsManager(baseTree());
    const layersHandler = jest.fn();
    const gridHandler = jest.fn();
    const entries: SettingsTreeEntry[] = [
      { path: ["layers"], node: { label: "Layers", handler: layersHandler } },
      { path: ["layers", "grid"], node: { label: "Grid", handler: gridHandler } },
    ];
    manager.setNodesForKey("grid", entries);
    const action = {
      action: "update" as const,
      payload: { path: ["layers", "grid", "visible"], input: "boolean" as const, value: false },
    };

    manager.handleAction(action);

    expect(layersHandler).toHaveBeenCalledWith(action);
    expect(gridHandler).toHaveBeenCalledWith(action);
  });

  it("runs node validators before inserting entries", () => {
    const manager = new SettingsManager(baseTree());
    const validator = jest.fn((entry: SettingsTreeEntry, errors: SettingsManager["errors"]) => {
      errors.add(entry.path, "validated", `Checked ${entry.path.join("/")}`);
    });
    manager.addNodeValidator(validator);

    manager.setNodesForKey("topics", [{ path: ["topics", "/tf"], node: {} }]);

    expect(validator).toHaveBeenCalledTimes(1);
    expect(manager.tree().topics?.children?.["/tf"]?.error).toBe("Checked topics//tf");
  });

  it("rejects an empty path", () => {
    const manager = new SettingsManager(baseTree());
    expect(() => {
      manager.setNodesForKey("bad", [{ path: [], node: { label: "Nowhere" } }]);
    }).toThrow('Empty path for settings node "Nowhere"');
  });

  it("updates node errors when layer errors change", () => {
    const manager = new SettingsManager(baseTree());
    manager.setNodesForKey("grid", [{ path: ["layers", "grid"], node: { label: "Grid" } }]);
    const update = jest.fn();
    manager.on("update", update);

    manager.errors.add(["layers", "grid"], "bad", "Invalid grid");
    expect(manager.tree().layers?.children?.grid?.error).toBe("Invalid grid");
    manager.errors.remove(["layers", "grid"], "bad");
    expect(manager.tree().layers?.children?.grid?.error).toBeUndefined();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("gives the tree a new identity for errors on paths without nodes", () => {
    const manager = new SettingsManager(baseTree());
    manager.setNodesForKey("grid", [{ path: ["layers", "grid"], node: { label: "Grid" } }]);
    const before = manager.tree();

    manager.errors.add(["layers", "missing"], "bad", "Missing layer");
    const after = manager.tree();
    expect(after).not.toBe(before);
    expect(after.layers).not.toBe(before.layers);
    expect(after.layers?.children?.grid).toBe(before.layers?.children?.grid);
    expect(after.layers?.children?.missing).toBeUndefined();
  });

  it("sets labels, creating nodes on the path", () => {
    const manager = new SettingsManager(baseTree());
    const update = jest.fn();
    manager.on("update", update);
    const before = manager.tree();

    manager.setLabel(["topics", "/camera"], "Camera");
    manager.setLabel(["general"], "Display frame");

    expect(manager.tree().topics).toEqual({ children: { "/camera": { label: "Camera" } } });
    expect(manager.tree().general).toEqual({ label: "Display frame" });
    expect(before.general).toEqual({ label: "Frame" });
    expect(update).toHaveBeenCalledTimes(2);
    expect(() => {
      manager.setLabel([], "Nowhere");
    }).toThrow('Empty path for settings label "Nowhere"');
  });

  it("clears children of an existing node only", () => {
    const manager = new SettingsManager(baseTree());
    manager.setNodesForKey("frames", [
      { path: ["transforms", "frame:a"], node: { label: "a" } },
      { path: ["transforms", "frame:b"], node: { label: "b" } },
    ]);
    const before = manager.tree();
    const update = jest.fn();
    manager.on("update", update);

    manager.clearChildren(["transforms"]);
    expect(manager.tree().transforms).toEqual({ children: undefined });
    expect(before.transforms?.children?.["frame:a"]?.label).toBe("a");

    const cleared = manager.tree();
    manager.clearChildren(["missing", "node"]);
    manager.clearChildren([]);
    expect(manager.tree()).toBe(cleared);
    expect(update).toHaveBeenCalledTimes(3);
  });
});
