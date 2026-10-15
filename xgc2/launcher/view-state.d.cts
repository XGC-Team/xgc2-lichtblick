// SPDX-License-Identifier: MPL-2.0
export class ViewError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number);
}
/** The embed surfaces, in canonical order. */
export const SURFACES: readonly string[];
export type Viewpoint = {
  readonly id: string;
  readonly transition: "smooth" | "instant";
};
export type ViewpointOption = { readonly id: string; readonly label: string };
export interface DesiredView {
  readonly viewpoint?: Viewpoint;
  /** Layout the page shows; null keeps the page's own choice. */
  readonly layoutId: string | null;
  /** Robot whose frame the 3D view follows; null keeps the page's own choice. */
  readonly followRobot: string | null;
  /** 3D projection: true perspective, false orthographic; null keeps the page's own choice. */
  readonly perspective: boolean | null;
  /** Exactly the embed surfaces that are shown; null keeps the page's own choice. */
  readonly visibleSurfaces: readonly string[] | null;
}
export interface ViewState {
  /** Process-local version of the view document, a decimal string; "0" before the first write. */
  readonly revision: string;
  readonly view: DesiredView;
}
export const EMPTY_VIEW: DesiredView;
/** Validates a view and returns its canonical form; throws a ViewError (400) otherwise. */
export function normalizeView(value: unknown): DesiredView;
export class ViewStore {
  constructor(viewpoints?: readonly ViewpointOption[]);
  readonly viewpoints: readonly ViewpointOption[];
  readonly state: ViewState;
  subscribe(listener: (state: ViewState) => void): () => void;
  set(
    view: unknown,
    options?: { expectedRevision?: string },
  ): Promise<ViewState & { unchanged: boolean }>;
}
