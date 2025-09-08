"use client";

import React, { useMemo, useRef, useState, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, TransformControls } from "@react-three/drei";
import * as THREE from "three";

// 4D Nexus Convergence Map (time as the 4th dimension) with play/pause, speed,
// time-slice convergence detection, and draggable + numeric Nexus control.

// ---------- Math / Utils ----------
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function rand(seed: number): number {
  // xorshift32
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  // convert to [0,1)
  return ((seed >>> 0) / 0xffffffff) % 1;
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  // h: [0, 360), s,l: [0,1]
  h = (h % 360 + 360) % 360;
  s = clamp(s, 0, 1);
  l = clamp(l, 0, 1);

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp >= 1 && hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp >= 2 && hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp >= 3 && hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp >= 4 && hp < 5) [r1, g1, b1] = [x, 0, c];
  else if (hp >= 5 && hp < 6) [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  return [r1 + m, g1 + m, b1 + m];
}

// ---------- Stream Param Generator ----------
interface StreamParams {
  fx: number;
  fy: number;
  fz: number;
  ampY: number;
  ampZ: number;
  twist: number;
  swirl: number;
  phaseY: number;
  phaseZ: number;
  colorSeed: number;
}

function makeStreamParams(id: string, seedBase: number): StreamParams {
  // Deterministic params per stream
  const s1 = Math.floor((seedBase + id.length * 13) * 1_000_003) | 0;
  const s2 = Math.floor((seedBase + id.length * 37) * 9_999_989) | 0;
  const s3 = Math.floor((seedBase + id.length * 91) * 7_000_001) | 0;
  const s4 = Math.floor((seedBase + id.length * 59) * 5_000_161) | 0;

  const fx = 1.0 + rand(s1) * 3.5; // spatial frequency along x
  const fy = 1.0 + rand(s2) * 3.0; // spatial frequency for y wave
  const fz = 1.0 + rand(s3) * 2.5; // spatial frequency for z wave

  const ampY = 0.25 + rand(s2 ^ s3) * 0.45; // scale against bounds.h
  const ampZ = 0.25 + rand(s1 ^ s4) * 0.45;

  const twist = (rand(s1 ^ s2) - 0.5) * 0.8; // lateral twist
  const swirl = (rand(s2 ^ s4) - 0.5) * 0.6; // z swirl

  const phaseY = rand(s3 ^ s4) * Math.PI * 2;
  const phaseZ = rand(s4 ^ s1) * Math.PI * 2;

  const colorSeed = Math.floor(rand(s1 ^ s2 ^ s3 ^ s4) * 360);
  return { fx, fy, fz, ampY, ampZ, twist, swirl, phaseY, phaseZ, colorSeed };
}

interface StreamPoint {
  x: number;
  y: number;
  z: number;
  u: number;
  intensity: number;
}

interface Bounds {
  w: number;
  h: number;
}

function pointOnStream(u: number, tau: number, params: StreamParams, bounds: Bounds): StreamPoint {
  // u in [0,1], tau is time
  const uCentered = u - 0.5;

  // Base x along width with gentle temporal drift
  const x = bounds.w * uCentered + Math.sin((u * params.fx + tau * 0.15) * Math.PI * 2) * params.twist * 25;

  // Wavy y and z with time evolution
  const y =
    (bounds.h * params.ampY) *
      Math.sin((u * params.fy + tau * 0.22) * Math.PI * 2 + params.phaseY) +
    Math.cos((u * 1.2 + tau * 0.07) * Math.PI * 2) * 10;

  const z =
    (bounds.h * params.ampZ) *
      Math.cos((u * params.fz + tau * 0.18) * Math.PI * 2 + params.phaseZ) +
    Math.sin((u * 0.9 + tau * 0.11) * Math.PI * 2) * params.swirl * 30;

  // intensity hint for visualization / convergence strength
  const intensity =
    0.5 +
    0.5 * Math.sin((u * (params.fy + params.fz) + tau * 0.2) * Math.PI * 2 + params.phaseY * 0.5 + params.phaseZ * 0.5);

  return { x, y, z, u, intensity };
}

function buildStreamPointsAtTime(params: StreamParams, bounds: Bounds, steps: number, tau: number): StreamPoint[] {
  const pts: StreamPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    pts.push(pointOnStream(u, tau, params, bounds));
  }
  return pts;
}

// ---------- Convergence Detection (4D slice at tau) ----------
interface StreamPointWithId extends StreamPoint {
  streamId: string;
}

interface Convergence {
  x: number;
  y: number;
  z: number;
  strength: number;
  u: number;
  streams: string[];
}

interface StreamData {
  id: string;
  params: StreamParams;
}

function detectConvergenceAtTime(streams: StreamData[], tau: number, sliceDu: number, threshold: number, steps: number, bounds: Bounds): Convergence[] {
  // streams: [{ id, params }]
  const all: StreamPointWithId[] = [];
  for (const s of streams) {
    const pts = buildStreamPointsAtTime(s.params, bounds, steps, tau);
    for (const p of pts) all.push({ ...p, streamId: s.id });
  }

  const convergences: Convergence[] = [];
  // simple pairwise - acceptable for small counts, with u-slice pruning
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (Math.abs(a.u - b.u) > sliceDu) continue; // only compare near same u "time slice"
      if (a.streamId === b.streamId) continue;

      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= threshold * threshold) {
        const cx = (a.x + b.x) * 0.5;
        const cy = (a.y + b.y) * 0.5;
        const cz = (a.z + b.z) * 0.5;
        const strength = (a.intensity + b.intensity) * 0.5;
        convergences.push({ x: cx, y: cy, z: cz, strength, u: (a.u + b.u) * 0.5, streams: [a.streamId, b.streamId] });
      }
    }
  }

  // Deduplicate roughly by voxel grid to avoid clusters of nearly identical points
  const voxel = threshold * 0.75;
  const seen = new Set<string>();
  const deduped: Convergence[] = [];
  for (const c of convergences) {
    const key = `${Math.round(c.x / voxel)}_${Math.round(c.y / voxel)}_${Math.round(c.z / voxel)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  // Sort strongest first, cap to prevent overload
  deduped.sort((a, b) => b.strength - a.strength);
  return deduped.slice(0, 200);
}

// ---------- R3F Components ----------
interface AnimationControllerProps {
  playing: boolean;
  speed: number;
  onTauUpdate: (tau: number) => void;
}

function AnimationController({ playing, speed, onTauUpdate }: AnimationControllerProps) {
  useFrame((_, delta) => {
    if (!playing) return;
    // delta is in seconds, normalized visual speed:
    onTauUpdate(delta * 0.15 * speed);
  });
  return null;
}

interface StreamProps {
  params: StreamParams;
  bounds: Bounds;
  steps: number;
  tau: number;
  hue: number;
  emphasizeU?: number | null;
  emphasizeWidth?: number;
  perVertexColor?: boolean;
}

function Stream({ params, bounds, steps, tau, hue, emphasizeU = null, emphasizeWidth = 0.05, perVertexColor = true }: StreamProps) {
  // Build positions and optional colors per render
  const positions = useMemo(() => {
    const pts = buildStreamPointsAtTime(params, bounds, steps, tau);
    const arr = new Float32Array((steps + 1) * 3);
    for (let i = 0; i <= steps; i++) {
      const p = pts[i];
      arr[i * 3 + 0] = p.x;
      arr[i * 3 + 1] = p.y;
      arr[i * 3 + 2] = p.z;
    }
    return arr;
  }, [params, bounds.w, bounds.h, steps, tau]);

  const colors = useMemo(() => {
    if (!perVertexColor) return null;
    const arr = new Float32Array((steps + 1) * 3);
    const base = hue % 360;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      let l = 0.5;
      if (emphasizeU != null) {
        const du = Math.abs(u - emphasizeU);
        // bell around emphasizeU
        const weight = Math.exp(-Math.pow(du / emphasizeWidth, 2));
        l = lerp(0.35, 0.8, weight);
      }
      const [r, g, b] = hslToRgb(base, 1, l);
      arr[i * 3 + 0] = r;
      arr[i * 3 + 1] = g;
      arr[i * 3 + 2] = b;
    }
    return arr;
  }, [steps, hue, emphasizeU, emphasizeWidth, perVertexColor]);

  const geometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (colors) {
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    return geom;
  }, [positions, colors]);

  return (
    <line>
      <primitive object={geometry} />
      <lineBasicMaterial
        vertexColors={!!colors}
        color={!colors ? `hsl(${hue} 100% 60%)` : undefined}
      />
    </line>
  );
}

interface ConvergenceProps {
  x: number;
  y: number;
  z: number;
  strength?: number;
}

function Convergence({ x, y, z, strength = 1 }: ConvergenceProps) {
  const s = 2.2 + strength * 2.0;
  return (
    <mesh position={[x, y, z]}>
      <sphereGeometry args={[s, 16, 16]} />
      <meshStandardMaterial color="#f97316" emissive="#f97316" emissiveIntensity={0.7} />
    </mesh>
  );
}

// ---------- Main Component ----------
interface StreamWithHue extends StreamData {
  hue: number;
}

interface NexusPoint {
  x: number;
  y: number;
  z: number;
}

export default function NexusConvergenceMap4D() {
  const bounds: Bounds = { w: 520, h: 520 };

  // Scene controls
  const [streamCount, setStreamCount] = useState(6);
  const [steps, setSteps] = useState(80);
  const [sliceDu, setSliceDu] = useState(0.025);
  const [threshold, setThreshold] = useState(64);
  const [perVertexColor, setPerVertexColor] = useState(true);

  // Time controls (tau)
  const [tau, setTau] = useState(0); // normalized time (unbounded, but we mod for visuals)
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1); // multiplier

  // Nexus point
  const [nexusPoint, setNexusPoint] = useState<NexusPoint>({ x: 0, y: 0, z: 0 });
  const nexusMeshRef = useRef<THREE.Mesh | null>(null);

  // Stable "streams" - only change when streamCount changes
  const streams = useMemo(() => {
    const arr: StreamWithHue[] = [];
    for (let i = 0; i < streamCount; i++) {
      const id = `S-${i + 1}`;
      const seedBase = Math.floor(Math.random() * 2 ** 31);
      const params = makeStreamParams(id, seedBase);
      arr.push({ id, params, hue: (params.colorSeed * 137.5) % 360 });
    }
    return arr;
  }, [streamCount]);

  // Animation handler for tau updates
  const handleTauUpdate = (deltaTime: number) => {
    setTau((t) => t + deltaTime);
  };

  const emphasizeU = useMemo(() => {
    // emphasize current param slice position in [0,1]
    const u0 = ((tau % 1) + 1) % 1; // wrap
    return u0;
  }, [tau]);

  // Compute convergences at current time slice
  const convergences = useMemo(() => {
    return detectConvergenceAtTime(streams, tau, sliceDu, threshold, steps, bounds);
  }, [streams, tau, sliceDu, threshold, steps, bounds.w, bounds.h]);

  // Sync position from input controls to 3D scene
  useEffect(() => {
    if (nexusMeshRef.current) {
      const { x, y, z } = nexusPoint;
      nexusMeshRef.current.position.set(x, y, z);
    }
  }, [nexusPoint]);

  return (
    <div className="p-4 bg-slate-900 min-h-screen text-slate-100">
      <h1 className="text-xl font-semibold mb-3">Nexus Convergence Map 4D (Time Slice)</h1>

      <div className="grid grid-cols-3 gap-4">
        <section className="col-span-2 h-[640px] bg-black rounded-lg overflow-hidden">
          <Canvas camera={{ position: [0, 0, 700], fov: 55 }}>
            <color attach="background" args={["#000000"]} />
            <ambientLight intensity={0.5} />
            <pointLight position={[140, 180, 220]} intensity={1.1} />
            
            <AnimationController 
              playing={playing} 
              speed={speed} 
              onTauUpdate={handleTauUpdate} 
            />

            {/* Nexus Point (draggable) */}
            <TransformControls
              mode="translate"
              onObjectChange={() => {
                if (nexusMeshRef.current) {
                  const p = nexusMeshRef.current.position;
                  setNexusPoint({ x: p.x, y: p.y, z: p.z });
                }
              }}
            >
              <mesh ref={nexusMeshRef} position={[nexusPoint.x, nexusPoint.y, nexusPoint.z]}>
                <sphereGeometry args={[12, 32, 32]} />
                <meshStandardMaterial color="#38bdf8" emissive="#38bdf8" emissiveIntensity={0.9} />
              </mesh>
            </TransformControls>

            {/* Streams */}
            {streams.map((s) => (
              <Stream
                key={s.id}
                params={s.params}
                bounds={bounds}
                steps={steps}
                tau={tau}
                hue={s.hue}
                emphasizeU={emphasizeU}
                emphasizeWidth={0.05}
                perVertexColor={perVertexColor}
              />
            ))}

            {/* Convergences at current time-slice */}
            {convergences.map((c, i) => (
              <Convergence key={i} {...c} />
            ))}

            <OrbitControls enableDamping makeDefault dampingFactor={0.12} />
          </Canvas>
        </section>

        <section className="col-span-1 bg-slate-800 p-3 rounded-lg space-y-3">
          <h2 className="text-sm font-medium">Time Controls</h2>
          <div className="text-xs space-y-2">
            <div className="flex items-center space-x-2">
              <button
                className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600"
                onClick={() => setPlaying((p) => !p)}
              >
                {playing ? "Pause" : "Play"}
              </button>
              <label className="flex items-center space-x-2">
                <span>Speed</span>
                <input
                  type="range"
                  min="0.1"
                  max="4"
                  step="0.1"
                  value={speed}
                  onChange={(e) => setSpeed(+e.target.value)}
                />
                <span className="w-8 text-right">{speed.toFixed(1)}x</span>
              </label>
            </div>
            <div className="flex items-center space-x-2">
              <span>τ:</span>
              <div className="px-1 py-0.5 bg-slate-900 rounded border border-slate-700">
                {(((tau % 1) + 1) % 1).toFixed(3)}
              </div>
              <button
                className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600"
                onClick={() => setTau(0)}
              >
                Reset τ
              </button>
            </div>
          </div>

          <h2 className="text-sm font-medium">Streams & Slice</h2>
          <div className="text-xs space-y-2">
            <label className="flex items-center justify-between space-x-2">
              <span>Streams</span>
              <input
                type="number"
                min="1"
                max="20"
                className="w-16 px-1 py-0.5 bg-slate-900 border border-slate-700 rounded"
                value={streamCount}
                onChange={(e) => setStreamCount(clamp(parseInt(e.target.value || "1", 10), 1, 20))}
              />
            </label>
            <label className="flex items-center justify-between space-x-2">
              <span>Steps/Stream</span>
              <input
                type="range"
                min="20"
                max="200"
                step="5"
                value={steps}
                onChange={(e) => setSteps(parseInt(e.target.value, 10))}
              />
              <span className="w-10 text-right">{steps}</span>
            </label>
            <label className="flex items-center justify-between space-x-2">
              <span>Slice Δu</span>
              <input
                type="range"
                min="0.005"
                max="0.15"
                step="0.005"
                value={sliceDu}
                onChange={(e) => setSliceDu(parseFloat(e.target.value))}
              />
              <span className="w-12 text-right">{sliceDu.toFixed(3)}</span>
            </label>
            <label className="flex items-center justify-between space-x-2">
              <span>Threshold (dist)</span>
              <input
                type="range"
                min="16"
                max="140"
                step="1"
                value={threshold}
                onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
              />
              <span className="w-12 text-right">{threshold}</span>
            </label>
            <label className="flex items-center space-x-2">
              <input
                type="checkbox"
                checked={perVertexColor}
                onChange={(e) => setPerVertexColor(e.target.checked)}
              />
              <span>Highlight current slice on streams</span>
            </label>
          </div>

          <h2 className="text-sm font-medium mt-2">Nexus Point</h2>
          <div className="text-xs space-y-2">
            <div className="flex space-x-2">
              <label className="flex items-center space-x-1">
                <span>X:</span>
                <input
                  type="number"
                  className="w-20 px-1 py-0.5 bg-slate-900 border border-slate-700 rounded"
                  value={nexusPoint.x.toFixed(0)}
                  onChange={(e) => {
                    const x = +e.target.value;
                    setNexusPoint((p) => ({ ...p, x }));
                    if (nexusMeshRef.current) nexusMeshRef.current.position.x = x;
                  }}
                />
              </label>
              <label className="flex items-center space-x-1">
                <span>Y:</span>
                <input
                  type="number"
                  className="w-20 px-1 py-0.5 bg-slate-900 border border-slate-700 rounded"
                  value={nexusPoint.y.toFixed(0)}
                  onChange={(e) => {
                    const y = +e.target.value;
                    setNexusPoint((p) => ({ ...p, y }));
                    if (nexusMeshRef.current) nexusMeshRef.current.position.y = y;
                  }}
                />
              </label>
              <label className="flex items-center space-x-1">
                <span>Z:</span>
                <input
                  type="number"
                  className="w-20 px-1 py-0.5 bg-slate-900 border border-slate-700 rounded"
                  value={nexusPoint.z.toFixed(0)}
                  onChange={(e) => {
                    const z = +e.target.value;
                    setNexusPoint((p) => ({ ...p, z }));
                    if (nexusMeshRef.current) nexusMeshRef.current.position.z = z;
                  }}
                />
              </label>
            </div>
          </div>

          <h2 className="text-sm font-medium mt-2">Convergences</h2>
          <ul className="text-xs space-y-2 max-h-60 overflow-y-auto">
            {convergences.slice(0, 20).map((c, i) => {
              const dx = c.x - nexusPoint.x;
              const dy = c.y - nexusPoint.y;
              const dz = c.z - nexusPoint.z;
              const dist = Math.sqrt(dx * dx + dy * dy + dz * dz).toFixed(1);
              return (
                <li key={i} className="bg-slate-900 p-2 rounded">
                  [{c.streams.join(", ")}] u={c.u.toFixed(3)} • dist {dist}
                </li>
              );
            })}
            {convergences.length === 0 && (
              <li className="text-slate-500">No convergences detected at this time-slice.</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}