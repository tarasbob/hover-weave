import * as THREE from "three/webgpu";

interface HullSection {
  z: number;
  width: number;
  top: number;
  bottom: number;
}

/** A six-sided aerospace section, with a broad dorsal panel and bevelled chines. */
export function createHullGeometry(): THREE.BufferGeometry {
  const sections: readonly HullSection[] = [
    { z: -1.5, width: 0.025, top: -0.01, bottom: -0.04 },
    { z: -0.75, width: 0.28, top: 0.14, bottom: -0.14 },
    { z: 0.02, width: 0.49, top: 0.22, bottom: -0.2 },
    { z: 0.58, width: 0.44, top: 0.15, bottom: -0.15 },
    { z: 0.94, width: 0.27, top: 0.07, bottom: -0.1 },
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const { z, width, top, bottom } of sections) {
    positions.push(
      -width * 0.62, top, z,
      width * 0.62, top, z,
      width, top * 0.05, z,
      width * 0.58, bottom, z,
      -width * 0.58, bottom, z,
      -width, top * 0.05, z,
    );
  }
  for (let section = 0; section < sections.length - 1; section++) {
    for (let edge = 0; edge < 6; edge++) {
      const a = section * 6 + edge;
      const b = section * 6 + (edge + 1) % 6;
      indices.push(a, a + 6, b, b, a + 6, b + 6);
    }
  }
  for (let edge = 1; edge < 5; edge++) {
    indices.push(0, edge, edge + 1);
    const last = (sections.length - 1) * 6;
    indices.push(last, last + edge + 1, last + edge);
  }
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  indexed.setIndex(indices);
  // Separate face normals preserve the manufactured panel breaks.
  const geometry = indexed.toNonIndexed();
  indexed.dispose();
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Swept, bevelled wing plate; the left wing is mirrored by its parent. */
export function createWingGeometry(sweep: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0.26, -0.12);
  shape.lineTo(0.94, 0.22 + sweep * 0.48);
  shape.lineTo(0.82, 0.86);
  shape.lineTo(0.26, 0.66);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.038,
    bevelEnabled: true,
    bevelThickness: 0.018,
    bevelSize: 0.018,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 1,
  });
  // The shape's y coordinate becomes the ship's fore/aft axis.
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0.045, 0);
  return geometry;
}
