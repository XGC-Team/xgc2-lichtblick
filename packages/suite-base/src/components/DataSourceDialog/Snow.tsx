// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useMediaQuery } from "@mui/material";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import * as THREE from "three";
import { makeStyles } from "tss-react/mui";

import { useVisibilityState } from "@lichtblick/hooks";
import {
  lastEmbeddedHostVisibility,
  subscribeEmbeddedHostVisibility,
} from "@lichtblick/suite-base/components/EmbeddedParkedSignal";

const useStyles = makeStyles()({
  container: {
    position: "absolute",
    top: "0",
    left: "0",
    width: "100%",
    height: "100%",
  },
});

export default function Snow({ effect }: { effect: "snow" | "confetti" }): React.JSX.Element {
  const { classes } = useStyles();
  const containerRef = useRef<HTMLDivElement>(ReactNull);
  const documentVisibility = useVisibilityState();
  const hostVisible = useSyncExternalStore(
    subscribeEmbeddedHostVisibility,
    lastEmbeddedHostVisibility,
    () => undefined,
  );
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const visible = documentVisibility === "visible" && hostVisible !== false && !reducedMotion;
  const paintRef = useRef<{ setVisibility(value: "visible" | "hidden"): void }>();

  useLayoutEffect(() => {
    let requestID: ReturnType<typeof requestAnimationFrame> | undefined;
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera();

    const POINT_COUNT = effect === "snow" ? 75 : 100;
    const positions = new Float32Array(POINT_COUNT * 3);
    const colors = new Float32Array(POINT_COUNT * 3);
    const sizes = new Float32Array(POINT_COUNT);
    const phases = new Float32Array(POINT_COUNT);

    const vertex = new THREE.Vector3();
    const color = new THREE.Color();
    for (let i = 0; i < POINT_COUNT; i++) {
      vertex.x = Math.random();
      vertex.y = Math.random();
      vertex.z = -1.0;
      vertex.toArray(positions, i * 3);

      if (effect === "snow") {
        color.setRGB(1.0, 1.0, 1.0);
      } else {
        color.setHSL(Math.random(), 1.0, 0.5);
      }
      color.toArray(colors, i * 3);

      sizes[i] = Math.random();
      phases[i] = Math.random() * Math.PI;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("phase", new THREE.BufferAttribute(phases, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 1.0 },
        yspeed: { value: effect === "snow" ? 0.1 : 0.2 },
        wind: { value: effect === "snow" ? 0.02 : 0.0 },
      },
      vertexShader: /* glsl */ `
      uniform float time;
      uniform float yspeed;
      uniform float wind;
      attribute vec3 color;
      attribute float size;
      attribute float phase;
      const float xspeed = 10.0;
      const float amplitude = 0.03;
      const float minsize = 5.0;
      const float maxsize = 12.0;
      varying vec4 vcolor;
      void main() {
        vcolor = vec4(color, 1.0);
        float x = mix(-1.0, 1.0, mod(
          position.x + sin(phase + time * xspeed * yspeed) * amplitude + time * xspeed * yspeed * wind,
          1.0));
				float y = mix(-1.0, 1.0, mod(position.y - time * yspeed * mix(0.2, 1.0, size), 1.0));
				gl_PointSize = mix(minsize, maxsize, size);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(x, y, position.z, 1.0);
			}
      `,
      fragmentShader: /* glsl */ `
      varying vec4 vcolor;
			void main() {
        if (length(gl_PointCoord * 2.0 - 1.0) > 1.0) {
          discard;
        }
				gl_FragColor = vcolor;
			}
      `,
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    const renderer = new THREE.WebGLRenderer({ alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    let elapsed = 0;
    let previousTime: number | undefined;
    function render() {
      material.uniforms.time!.value = elapsed / 1000;
      renderer.render(scene, camera);
    }

    let animating = false;
    function animate(now: number) {
      requestID = undefined;
      if (!animating) {
        return;
      }
      if (previousTime != undefined) {
        elapsed += now - previousTime;
      }
      previousTime = now;
      render();
      requestID = requestAnimationFrame(animate);
    }

    paintRef.current = {
      setVisibility(value) {
        const next = value === "visible";
        if (animating === next) {
          return;
        }
        animating = next;
        previousTime = undefined;
        if (!next && requestID != undefined) {
          cancelAnimationFrame(requestID);
          requestID = undefined;
        } else if (next) {
          render();
          requestID = requestAnimationFrame(animate);
        }
      },
    };

    return () => {
      animating = false;
      paintRef.current = undefined;
      if (requestID != undefined) {
        cancelAnimationFrame(requestID);
      }
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, [effect]);

  useLayoutEffect(() => {
    paintRef.current?.setVisibility(visible ? "visible" : "hidden");
  }, [visible, effect]);

  return <div className={classes.container} ref={containerRef} />;
}
