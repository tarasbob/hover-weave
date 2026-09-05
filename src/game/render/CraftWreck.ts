import * as THREE from "three/webgpu";
import { clamp } from "../core/mathUtils";
import { crashCenter, crashSeparation, type CrashOrigin } from "./crashMotion";

interface Fragment {
  mesh: THREE.Group;
  rest: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
}

/** Reusable ship sections; no geometry creation or GPU compilation on impact. */
export class CraftWreck {
  readonly group = new THREE.Group();
  readonly fragments: Fragment[] = [];
  origin: CrashOrigin | null = null;
  private readonly orientation = new THREE.Quaternion();
  private readonly spinRotation = new THREE.Quaternion();
  private readonly spinEuler = new THREE.Euler();
  private readonly offset = new THREE.Vector3();

  constructor() {
    this.group.visible = false;
    this.group.name = "ship-crash-fragments";
  }

  /** Share the ship's geometry/materials while keeping each fragment transform. */
  add(...objects: THREE.Object3D[]): void {
    const mesh = new THREE.Group();
    const content = new THREE.Group();
    objects.forEach((object) => content.add(object.clone(true)));
    content.updateMatrixWorld(true);
    const center = new THREE.Box3().setFromObject(content).getCenter(new THREE.Vector3());
    content.position.sub(center);
    mesh.add(content);
    mesh.position.copy(center);
    this.group.add(mesh);

    const index = this.fragments.length;
    const angle = index * 2.399963;
    const side = Math.abs(center.x) > 0.1 ? Math.sign(center.x) : Math.cos(angle);
    this.fragments.push({
      mesh,
      rest: center,
      velocity: new THREE.Vector3(
        side * (1.25 + (index % 3) * 0.45),
        1.7 + (index % 4) * 0.65,
        Math.sin(angle) * 1.65,
      ),
      spin: new THREE.Vector3(
        Math.sin(angle + 0.8) * 2.4,
        Math.cos(angle) * 1.8,
        side * (1.4 + (index % 3) * 0.7),
      ),
    });
  }

  start(origin: CrashOrigin, attitude: THREE.Euler): void {
    this.origin = { ...origin };
    this.orientation.setFromEuler(attitude);
    this.group.visible = true;
  }

  reset(): void {
    this.origin = null;
    this.group.visible = false;
  }

  update(elapsed: number, reduceMotion: boolean): void {
    const origin = this.origin;
    if (!origin) return;
    const center = crashCenter(origin, elapsed, reduceMotion);
    const edge = origin.cause === "edge";
    const t = crashSeparation(elapsed, edge);
    const motion = reduceMotion ? 0.4 : 1;
    const spread = (1 - Math.exp(-t * 1.15)) / 1.15;
    this.group.position.set(center.x, center.y, center.z);
    this.group.visible = elapsed < 3.5;

    for (let index = 0; index < this.fragments.length; index++) {
      const fragment = this.fragments[index];
      this.offset.copy(fragment.rest).applyQuaternion(this.orientation);
      const x = this.offset.x + fragment.velocity.x * spread * motion;
      const z = this.offset.z + fragment.velocity.z * spread * motion;
      let y = this.offset.y + (fragment.velocity.y * t - 2.8 * t * t) * motion;
      let spinTime = t;
      {
        const floor = 0.14 + (index % 3) * 0.055 - center.y;
        if (y < floor) {
          // A small, damped skid/bounce keeps detached panels readable on deck.
          const vy = fragment.velocity.y * motion;
          const gravity = 2.8 * motion;
          const impact = (vy + Math.sqrt(vy * vy + 4 * gravity * (this.offset.y - floor))) / (2 * gravity);
          const grounded = Math.max(0, t - impact);
          y = floor + Math.abs(Math.sin(grounded * 8)) * 0.12 * Math.exp(-grounded * 3) * motion;
          spinTime = impact + (1 - Math.exp(-grounded * 5)) * 0.2;
        }
      }
      fragment.mesh.position.set(x, y, z);
      this.spinEuler.set(
        fragment.spin.x * spinTime * motion,
        fragment.spin.y * spinTime * motion,
        fragment.spin.z * spinTime * motion,
      );
      this.spinRotation.setFromEuler(this.spinEuler);
      fragment.mesh.quaternion.copy(this.orientation).multiply(this.spinRotation);
      // Keep all pieces present through the reveal, then settle out together.
      const fade = 1 - clamp((elapsed - 2.6) / 0.8, 0, 1) * 0.3;
      fragment.mesh.scale.setScalar(fade);
    }
  }
}
