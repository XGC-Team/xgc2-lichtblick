/** @jest-environment node */

import { customUrdfLayerNeedsReload } from "./customUrdfLayer";

describe("customUrdfLayerNeedsReload", () => {
  const mecanum = "<robot name='mecanum'/>";

  it("keeps a parked layer when XML, prefix, and parameter are unchanged", () => {
    expect(
      customUrdfLayerNeedsReload(
        { urdf: mecanum, framePrefix: "xgc/robots/ugv2/", parameter: "/ugv2/visual_robot_description" },
        { urdf: mecanum, framePrefix: "xgc/robots/ugv2/", parameter: "/ugv2/visual_robot_description" },
      ),
    ).toBe(false);
  });

  it("reloads when a Scout scene-model alias is replaced by the mecanum slot name", () => {
    expect(
      customUrdfLayerNeedsReload(
        { urdf: mecanum, framePrefix: "xgc/robots/ugv3/", parameter: "/ugv2/visual_robot_description" },
        { urdf: mecanum, framePrefix: "xgc/robots/ugv2/", parameter: "/ugv2/visual_robot_description" },
      ),
    ).toBe(true);
  });

  it("reloads when the parameter identity changes even if XML is identical", () => {
    expect(
      customUrdfLayerNeedsReload(
        { urdf: mecanum, framePrefix: "xgc/robots/ugv2/", parameter: "/ugv3/visual_robot_description" },
        { urdf: mecanum, framePrefix: "xgc/robots/ugv2/", parameter: "/ugv2/visual_robot_description" },
      ),
    ).toBe(true);
  });

  it("honors forceReload", () => {
    const same = { urdf: mecanum, framePrefix: "xgc/robots/ugv1/", parameter: "/ugv1/visual_robot_description" };
    expect(customUrdfLayerNeedsReload(same, same, true)).toBe(true);
  });
});
