// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  Alert,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import * as _ from "lodash-es";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import { makeStyles } from "tss-react/mui";
import { v4 as uuid } from "uuid";

import { ObstacleSceneExtension } from "./ObstacleSceneExtension";
import { SceneEditorSession } from "./SceneEditorSession";
import { createObstacle, SCENE_PRESETS, type ScenePreset } from "./geometry";
import { withObstacleMotion, withObstaclePose } from "./motion";
import {
  geometryValid,
  type SceneGeometry,
  type SceneObstacle,
  type SceneMotion,
  type ScenePose,
  type Vec3,
} from "./types";
import { useRenderer } from "../RendererContext";

const useStyles = makeStyles()((theme) => ({
  root: {
    position: "absolute",
    left: theme.spacing(1),
    top: theme.spacing(1),
    maxHeight: "calc(100% - 16px)",
    maxWidth: "calc(100% - 16px)",
    overflow: "auto",
    pointerEvents: "auto",
    zIndex: 2,
  },
  body: { width: 288, maxWidth: "100%", padding: theme.spacing(1), gap: theme.spacing(1) },
  row: { display: "flex", flexWrap: "wrap", gap: theme.spacing(0.5) },
  vector: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: theme.spacing(0.5),
  },
}));

function NumericField({
  label,
  ariaLabel,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  ariaLabel?: string;
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(Number(value.toFixed(6))));
  const [error, setError] = useState(false);
  useEffect(() => {
    setDraft(String(Number(value.toFixed(6))));
    setError(false);
  }, [value, disabled]);
  return (
    <TextField
      size="small"
      label={label}
      value={draft}
      disabled={disabled}
      error={error}
      slotProps={{ htmlInput: { inputMode: "decimal", "aria-label": ariaLabel ?? label } }}
      onChange={(event) => {
        setDraft(event.target.value);
        setError(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          (event.target as HTMLInputElement).blur();
        }
        if (event.key === "Escape") {
          setDraft(String(value));
          setError(false);
          event.stopPropagation();
        }
      }}
      onBlur={() => {
        const next = Number(draft);
        if (draft.trim().length === 0 || !Number.isFinite(next)) {
          setError(true);
          return;
        }
        if (next !== value) {
          onCommit(next);
        }
      }}
    />
  );
}

function VectorFields({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: Vec3;
  disabled: boolean;
  onCommit: (value: Vec3) => void;
}): React.JSX.Element {
  const { classes } = useStyles();
  return (
    <Stack gap={0.5}>
      <Typography variant="caption">{label}</Typography>
      <div className={classes.vector}>
        {value.map((number, i) => (
          <NumericField
            key={i}
            label={["X", "Y", "Z"][i]!}
            ariaLabel={`${label} ${["X", "Y", "Z"][i]}`}
            value={number}
            disabled={disabled}
            onCommit={(next) => {
              const copy: Vec3 = [...value];
              copy[i] = next;
              onCommit(copy);
            }}
          />
        ))}
      </div>
    </Stack>
  );
}

function GeometryFields({
  geometry,
  disabled,
  onCommit,
  zh,
}: {
  geometry: SceneGeometry;
  disabled: boolean;
  onCommit: (value: SceneGeometry) => void;
  zh: boolean;
}): React.JSX.Element {
  if (geometry.type === "box") {
    return (
      <VectorFields
        label={zh ? "完整边长（米）" : "Full size (m)"}
        value={geometry.size}
        disabled={disabled}
        onCommit={(size) => {
          onCommit({ ...geometry, size });
        }}
      />
    );
  }
  if (geometry.type === "convex") {
    const bounds = new THREE.Box3().setFromPoints(
      geometry.vertices.map((v) => new THREE.Vector3(...v)),
    );
    const size = bounds.getSize(new THREE.Vector3()).toArray();
    return (
      <VectorFields
        label={zh ? "局部尺寸（米）" : "Local size (m)"}
        value={size}
        disabled={disabled}
        onCommit={(next) => {
          onCommit({
            ...geometry,
            vertices: geometry.vertices.map(
              (v) => v.map((n, i) => (n * next[i]!) / size[i]!) as Vec3,
            ),
          });
        }}
      />
    );
  }
  return (
    <>
      <NumericField
        label={zh ? "半径（米）" : "Radius (m)"}
        value={geometry.radius}
        disabled={disabled}
        onCommit={(radius) => {
          onCommit({ ...geometry, radius });
        }}
      />
      {geometry.type !== "sphere" && (
        <NumericField
          label={
            geometry.type === "capsule"
              ? zh
                ? "圆柱段高度（米）"
                : "Cylinder section height (m)"
              : zh
                ? "完整高度（米）"
                : "Full height (m)"
          }
          value={geometry.height}
          disabled={disabled}
          onCommit={(height) => {
            onCommit({ ...geometry, height });
          }}
        />
      )}
    </>
  );
}

function MotionFields({
  motion,
  position,
  disabled,
  zh,
  onCommit,
}: {
  motion: SceneMotion;
  position: Vec3;
  disabled: boolean;
  zh: boolean;
  onCommit: (motion: SceneMotion) => void;
}): React.JSX.Element {
  const defaults: Record<SceneMotion["type"], SceneMotion> = {
    hold: { type: "hold" },
    constant_twist: { type: "constant_twist", linear: [0.2, 0, 0], angular: [0, 0, 0] },
    ping_pong: {
      type: "ping_pong",
      point_a: [...position],
      point_b: [position[0] + 2, position[1], position[2]],
      speed: 0.2,
    },
    circle: {
      type: "circle",
      center: [position[0] - 1, position[1], position[2]],
      radius: 1,
      angular_speed: 0.2,
      phase: 0,
    },
  };
  return (
    <>
      <TextField
        select
        size="small"
        label={zh ? "运动" : "Motion"}
        value={motion.type}
        disabled={disabled}
        onChange={(event) => { onCommit(defaults[event.target.value as SceneMotion["type"]]); }}
      >
        <MenuItem value="hold">{zh ? "静止" : "Hold"}</MenuItem>
        <MenuItem value="constant_twist">{zh ? "恒定速度" : "Constant twist"}</MenuItem>
        <MenuItem value="ping_pong">{zh ? "往返" : "Back and forth"}</MenuItem>
        <MenuItem value="circle">{zh ? "圆周" : "Circle"}</MenuItem>
      </TextField>
      {motion.type === "constant_twist" && (
        <>
          <VectorFields
            label={zh ? "速度（米/秒）" : "Velocity (m/s)"}
            value={motion.linear}
            disabled={disabled}
            onCommit={(linear) => { onCommit({ ...motion, linear }); }}
          />
          <VectorFields
            label={zh ? "角速度（弧度/秒）" : "Angular velocity (rad/s)"}
            value={motion.angular}
            disabled={disabled}
            onCommit={(angular) => { onCommit({ ...motion, angular }); }}
          />
        </>
      )}
      {motion.type === "ping_pong" && (
        <>
          <VectorFields
            label={zh ? "起点（米）" : "Point A (m)"}
            value={motion.point_a}
            disabled={disabled}
            onCommit={(point_a) => { onCommit({ ...motion, point_a }); }}
          />
          <VectorFields
            label={zh ? "终点（米）" : "Point B (m)"}
            value={motion.point_b}
            disabled={disabled}
            onCommit={(point_b) => { onCommit({ ...motion, point_b }); }}
          />
          <NumericField
            label={zh ? "速度（米/秒）" : "Speed (m/s)"}
            value={motion.speed}
            disabled={disabled}
            onCommit={(speed) => { onCommit({ ...motion, speed }); }}
          />
        </>
      )}
      {motion.type === "circle" && (
        <>
          <VectorFields
            label={zh ? "圆心（米）" : "Center (m)"}
            value={motion.center}
            disabled={disabled}
            onCommit={(center) => { onCommit({ ...motion, center }); }}
          />
          <NumericField
            label={zh ? "轨迹半径（米）" : "Path radius (m)"}
            value={motion.radius}
            disabled={disabled}
            onCommit={(radius) => { onCommit({ ...motion, radius }); }}
          />
          <NumericField
            label={zh ? "圆周角速度（弧度/秒）" : "Orbit speed (rad/s)"}
            value={motion.angular_speed}
            disabled={disabled}
            onCommit={(angular_speed) => { onCommit({ ...motion, angular_speed }); }}
          />
          <NumericField
            label={zh ? "初始相位（弧度）" : "Initial phase (rad)"}
            value={motion.phase}
            disabled={disabled}
            onCommit={(phase) => { onCommit({ ...motion, phase }); }}
          />
        </>
      )}
    </>
  );
}

const PRESET_ZH: Record<ScenePreset, string> = {
  Box: "长方体",
  Sphere: "球",
  Cylinder: "圆柱",
  Capsule: "胶囊",
  Icosahedron: "二十面体",
  Arch: "门框",
  "L block": "L 形块",
  "T block": "T 形块",
  Stairs: "阶梯",
  Dumbbell: "哑铃",
};

function SceneInspector({
  extension,
  session,
}: {
  extension: ObstacleSceneExtension;
  session: SceneEditorSession;
}): React.JSX.Element {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const { classes } = useStyles();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { envelope, selection } = state;
  const [preset, setPreset] = useState<ScenePreset>("Box");
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [mode, setMode] = useState<"translate" | "rotate" | "scale">("translate");
  const [local, setLocal] = useState(false);
  const obstacle = envelope?.document.obstacles.find((o) => o.id === selection?.obstacleId);
  const part = obstacle?.parts.find((p) => p.id === selection?.partId);
  const dimensionPart = part ?? (obstacle?.parts.length === 1 ? obstacle.parts[0] : undefined);
  const pose = part?.pose ?? obstacle?.pose;
  const rotation = pose
    ? (new THREE.Euler()
        .setFromQuaternion(new THREE.Quaternion(...pose.orientation), "XYZ")
        .toArray()
        .slice(0, 3)
        .map((v) => (Number(v) * 180) / Math.PI) as Vec3)
    : undefined;
  const writable = session.canEdit();
  const transformable = extension.canTransform();
  const consumers = envelope?.consumers ?? [];
  const failed = consumers.filter((consumer) => !consumer.success);
  const awaiting = consumers.some((consumer) => consumer.revision !== envelope?.revision);
  const update = (next: SceneObstacle) => {
    void session.command({ operation: "update", obstacle: next });
  };
  const updatePose = (next: ScenePose) => {
    if (!obstacle) {
      return;
    }
    update(
      part
        ? {
            ...obstacle,
            parts: obstacle.parts.map((p) => (p.id === part.id ? { ...p, pose: next } : p)),
          }
        : withObstaclePose(obstacle, next),
    );
  };
  const create = async (target: "obstacle" | "part", customGeometry?: SceneGeometry) => {
    const next = createObstacle(preset, uuid());
    if (customGeometry) {
      next.name = zh ? "凸多面体" : "Convex polyhedron";
      next.parts = [{ ...next.parts[0]!, geometry: customGeometry }];
    }
    if (target === "part" && obstacle) {
      update({
        ...obstacle,
        parts: [...obstacle.parts, ...next.parts.map((p) => ({ ...p, id: `${next.id}-${p.id}` }))],
      });
    } else if (await session.command({ operation: "add", obstacle: next })) {
      session.select({ obstacleId: next.id });
    }
  };

  return (
    <Paper className={classes.root} elevation={4} data-testid="obstacle-scene-editor">
      <Button
        size="small"
        onClick={() => {
          session.setActive({ active: !state.active });
        }}
      >
        {zh ? "障碍场景" : "Obstacle scene"}
        {envelope?.dirty === true ? " •" : ""}
      </Button>
      {state.active && (
        <Stack className={classes.body}>
          <Typography variant="caption">
            {!state.live || !state.authorized
              ? zh
                ? "只读 · 请从实验打开在线场景"
                : "Read only · Open a live scene from the experiment"
              : !envelope
                ? zh
                  ? "等待布景工作流加载场景"
                  : "Waiting for the scene workflow"
                : state.pending
                  ? zh
                    ? "正在更新场景…"
                    : "Updating scene…"
                  : envelope.dirty
                    ? zh
                      ? "现场已更新 · 尚未保存"
                      : "Live changes · Unsaved"
                    : zh
                      ? "已保存"
                      : "Saved"}
          </Typography>
          {state.error && <Alert severity="error">{state.error}</Alert>}
          {envelope?.synchronized === false && (
            <Alert severity="error">
              {zh
                ? "场景更新尚未在各端同步，请检查错误或重试同步。"
                : "The scene update is not synchronized everywhere. Check the errors or retry synchronization."}
              <Button
                size="small"
                disabled={!state.live || !state.authorized || state.pending}
                onClick={() => void session.command({ operation: "resync" })}
              >
                {zh ? "重试同步" : "Retry sync"}
              </Button>
            </Alert>
          )}
          {failed.map((consumer) => (
            <Alert severity="error" key={consumer.consumer}>
              {consumer.message ||
                (zh
                  ? "场景使用方未能应用更新，请检查对应工作流。"
                  : "A scene consumer could not apply the update. Check its workflow.")}
            </Alert>
          ))}
          {awaiting && (
            <Alert severity="info">
              {zh
                ? "正在等待场景使用方同步；各端尚未全部生效。"
                : "Waiting for scene consumers; the update is not yet applied everywhere."}
            </Alert>
          )}
          <div className={classes.row}>
            <Button
              size="small"
              disabled={!state.live || !state.authorized || state.pending}
              onClick={() => void session.command({ operation: "get" })}
            >
              {zh ? "刷新" : "Refresh"}
            </Button>
            <Button
              size="small"
              disabled={!writable}
              onClick={() => void session.command({ operation: "undo" })}
            >
              {zh ? "撤销" : "Undo"}
            </Button>
            <Button
              size="small"
              disabled={!writable}
              onClick={() => void session.command({ operation: "redo" })}
            >
              {zh ? "重做" : "Redo"}
            </Button>
          </div>
          <div className={classes.row}>
            <Button
              size="small"
              disabled={!writable}
              onClick={() =>
                void session.command({ operation: envelope?.playing === true ? "pause" : "play" })
              }
            >
              {envelope?.playing === true ? (zh ? "暂停" : "Pause") : zh ? "播放" : "Play"}
            </Button>
            <Button
              size="small"
              disabled={!writable}
              onClick={() => void session.command({ operation: "reset" })}
            >
              {zh ? "复位运动" : "Reset motion"}
            </Button>
          </div>
          <TextField
            select
            size="small"
            label={zh ? "创建形状" : "Create shape"}
            value={preset}
            onChange={(event) => {
              setPreset(event.target.value as ScenePreset);
            }}
          >
            {SCENE_PRESETS.map((name) => (
              <MenuItem key={name} value={name}>
                {zh ? PRESET_ZH[name] : name}
              </MenuItem>
            ))}
          </TextField>
          <div className={classes.row}>
            <Button size="small" disabled={!writable} onClick={() => void create("obstacle")}>
              {zh ? "添加障碍" : "Add obstacle"}
            </Button>
            <Button size="small" disabled={!transformable} onClick={() => void create("part")}>
              {zh ? "添加部件" : "Add part"}
            </Button>
            <Button
              size="small"
              onClick={() => {
                setShowImport(!showImport);
              }}
            >
              {zh ? "导入凸体" : "Import convex"}
            </Button>
          </div>
          {showImport && (
            <>
              <TextField
                multiline
                minRows={3}
                size="small"
                label={zh ? "顶点和三角面 JSON" : "Vertices and triangles JSON"}
                value={importText}
                onChange={(event) => {
                  setImportText(event.target.value);
                }}
                placeholder='{"vertices":[[0,0,0],…],"triangles":[0,1,2,…]}'
              />
              <Button
                size="small"
                disabled={!writable}
                onClick={() => {
                  try {
                    const geometry: unknown = { ...JSON.parse(importText), type: "convex" };
                    if (!geometryValid(geometry)) {
                      throw new Error(
                        zh
                          ? "请提供有效的三维顶点与三角面索引。"
                          : "Provide valid 3D vertices and triangle indices.",
                      );
                    }
                    void create("obstacle", geometry);
                  } catch (error) {
                    session.reportError(error);
                  }
                }}
              >
                {zh ? "添加凸多面体" : "Add convex polyhedron"}
              </Button>
            </>
          )}
          <TextField
            select
            size="small"
            label={zh ? "障碍物" : "Obstacle"}
            slotProps={{ select: { displayEmpty: true } }}
            value={obstacle?.id ?? ""}
            onChange={(event) => {
              session.select(event.target.value ? { obstacleId: event.target.value } : undefined);
            }}
          >
            <MenuItem value="">{zh ? "选择障碍物" : "Select an obstacle"}</MenuItem>
            {envelope?.document.obstacles.map((o) => (
              <MenuItem value={o.id} key={o.id}>
                {o.name || o.id}
              </MenuItem>
            ))}
          </TextField>
          {obstacle && (
            <>
              <TextField
                select
                size="small"
                label={zh ? "编辑范围" : "Edit target"}
                slotProps={{ select: { displayEmpty: true } }}
                value={part?.id ?? ""}
                onChange={(event) => {
                  session.select({
                    obstacleId: obstacle.id,
                    ...(event.target.value ? { partId: event.target.value } : {}),
                  });
                }}
              >
                <MenuItem value="">{zh ? "整个障碍物" : "Whole obstacle"}</MenuItem>
                {obstacle.parts.map((p) => (
                  <MenuItem value={p.id} key={p.id}>
                    {p.id} · {p.geometry.type}
                  </MenuItem>
                ))}
              </TextField>
              {obstacle.motion.type !== "hold" && !transformable && (
                <Alert severity="info">
                  {zh
                    ? "暂停并复位运动后再编辑初始布景。保存不会改变运动中的初始位置。"
                    : "Pause and reset motion to edit initial placement. Saving preserves the initial pose."}
                </Alert>
              )}
              <TextField
                key={`${obstacle.id}:${envelope?.revision}`}
                size="small"
                label={zh ? "名称" : "Name"}
                defaultValue={obstacle.name}
                disabled={!writable}
                onBlur={(event) => {
                  if (event.target.value !== obstacle.name) {
                    update({ ...obstacle, name: event.target.value });
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    (event.target as HTMLInputElement).blur();
                  }
                }}
              />
              <MotionFields
                motion={obstacle.motion}
                position={obstacle.pose.position}
                zh={zh}
                disabled={!writable || envelope?.playing === true}
                onCommit={(motion) => { update(withObstacleMotion(obstacle, motion)); }}
              />
              <div className={classes.row}>
                {(["translate", "rotate", "scale"] as const).map((value) => (
                  <Button
                    size="small"
                    key={value}
                    variant={mode === value ? "contained" : "outlined"}
                    disabled={!transformable || (value === "scale" && !extension.canScale())}
                    onClick={() => {
                      setMode(value);
                      extension.setMode(value);
                    }}
                  >
                    {zh
                      ? { translate: "移动", rotate: "旋转", scale: "尺寸" }[value]
                      : { translate: "Move", rotate: "Rotate", scale: "Scale" }[value]}
                  </Button>
                ))}
              </div>
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={local}
                    onChange={(_event, checked) => {
                      setLocal(checked);
                      extension.setLocalSpace({ local: checked });
                    }}
                  />
                }
                label={zh ? "局部操作轴" : "Local axes"}
              />
              <Typography variant="caption">
                {zh
                  ? "拖动松手即提交；Esc 取消。Alt 点击可选部件。"
                  : "Release a drag to update; Esc cancels. Alt-click selects a part."}
              </Typography>
              {pose && (
                <VectorFields
                  label={
                    part
                      ? zh
                        ? "部件位置（米）"
                        : "Part position (m)"
                      : zh
                        ? "初始位置（米）"
                        : "Initial position (m)"
                  }
                  value={pose.position}
                  disabled={!transformable}
                  onCommit={(position) => {
                    updatePose({ ...pose, position });
                  }}
                />
              )}
              {pose && rotation && (
                <VectorFields
                  label={zh ? "旋转 XYZ（度）" : "Rotation XYZ (deg)"}
                  value={rotation}
                  disabled={!transformable}
                  onCommit={(angles) => {
                    updatePose({
                      ...pose,
                      orientation: new THREE.Quaternion()
                        .setFromEuler(
                          new THREE.Euler(
                            ...(angles.map((v) => (v * Math.PI) / 180) as Vec3),
                            "XYZ",
                          ),
                        )
                        .toArray() as ScenePose["orientation"],
                    });
                  }}
                />
              )}
              {dimensionPart && (
                <GeometryFields
                  geometry={dimensionPart.geometry}
                  disabled={!transformable}
                  zh={zh}
                  onCommit={(geometry) => {
                    if (!geometryValid(geometry)) {
                      session.reportError(
                        zh
                          ? "尺寸必须为正数，几何体不能退化。"
                          : "Dimensions must be positive; the geometry cannot collapse.",
                      );
                      return;
                    }
                    update({
                      ...obstacle,
                      parts: obstacle.parts.map((p) =>
                        p.id === dimensionPart.id ? { ...p, geometry } : p,
                      ),
                    });
                  }}
                />
              )}
              <div className={classes.row}>
                <Button
                  size="small"
                  disabled={!writable}
                  onClick={() => {
                    const duplicate = _.cloneDeep(obstacle);
                    const copy = withObstaclePose(duplicate, { ...duplicate.pose, position: [duplicate.pose.position[0] + 0.5, duplicate.pose.position[1], duplicate.pose.position[2]] });
                    copy.id = uuid();
                    copy.name += zh ? " 副本" : " copy";
                    void session.command({ operation: "add", obstacle: copy }).then((success) => {
                      if (success) {
                        session.select({ obstacleId: copy.id });
                      }
                    });
                  }}
                >
                  {zh ? "复制障碍" : "Copy obstacle"}
                </Button>
                <Button
                  size="small"
                  color="error"
                  disabled={
                    !writable ||
                    (part != undefined && (!transformable || obstacle.parts.length === 1))
                  }
                  onClick={() => {
                    if (part) {
                      update({
                        ...obstacle,
                        parts: obstacle.parts.filter((p) => p.id !== part.id),
                      });
                    } else {
                      void session.command({ operation: "delete", id: obstacle.id });
                    }
                  }}
                >
                  {part ? (zh ? "删除部件" : "Delete part") : zh ? "删除障碍" : "Delete obstacle"}
                </Button>
              </div>
            </>
          )}
          <TextField
            size="small"
            label={zh ? "另存为（可选相对路径）" : "Save as (optional relative path)"}
            value={savePath}
            onChange={(event) => {
              setSavePath(event.target.value);
            }}
          />
          <Button
            size="small"
            variant="outlined"
            disabled={!writable}
            onClick={() =>
              void session.command({
                operation: "save",
                ...(savePath.trim() ? { path: savePath.trim() } : {}),
              })
            }
          >
            {zh ? "保存 YAML" : "Save YAML"}
          </Button>
        </Stack>
      )}
    </Paper>
  );
}

export function ObstacleSceneEditor({ live }: { live: boolean }): React.JSX.Element | undefined {
  const renderer = useRenderer();
  const extension = renderer?.sceneExtensions.get(ObstacleSceneExtension.extensionId);
  const scene = extension instanceof ObstacleSceneExtension ? extension : undefined;
  useEffect(() => {
    scene?.session?.setLive({ live });
    return () => scene?.session?.setLive({ live: false });
  }, [scene, live]);
  return scene?.session ? <SceneInspector extension={scene} session={scene.session} /> : undefined;
}
