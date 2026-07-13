import * as THREE from 'three';

export interface ShipModelParts {
  group: THREE.Group;
  flame: THREE.Mesh;
  trail: THREE.Mesh;
  engine: THREE.Mesh;
}

export function createShipModel(): ShipModelParts {
  const group = new THREE.Group();

  // Fuselage — low-poly needle, points toward +Z.
  const fuselageGeo = new THREE.ConeGeometry(1.2, 5, 8);
  fuselageGeo.rotateX(Math.PI / 2); // point along +Z
  const fuselageMat = new THREE.MeshStandardMaterial({
    color: 0x2dd4bf,
    emissive: 0x0f766e,
    emissiveIntensity: 0.6,
    roughness: 0.3,
    metalness: 0.7,
    flatShading: true,
  });
  const fuselage = new THREE.Mesh(fuselageGeo, fuselageMat);
  group.add(fuselage);

  // Engine housing.
  const engineGeo = new THREE.CylinderGeometry(0.8, 1.2, 1.4, 8);
  engineGeo.rotateX(Math.PI / 2);
  const engineMat = new THREE.MeshStandardMaterial({
    color: 0xf59e0b,
    emissive: 0xb45309,
    emissiveIntensity: 1.5,
    roughness: 0.4,
    metalness: 0.5,
    flatShading: true,
  });
  const engine = new THREE.Mesh(engineGeo, engineMat);
  engine.position.z = -1.1;
  group.add(engine);

  // Three fins, 120° apart.
  const finGeo = new THREE.BoxGeometry(2.6, 0.12, 1.1);
  const finMat = new THREE.MeshStandardMaterial({
    color: 0x22d3ee,
    emissive: 0x0891b2,
    emissiveIntensity: 0.4,
    roughness: 0.3,
    metalness: 0.6,
    flatShading: true,
  });
  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(finGeo, finMat);
    const angle = (i / 3) * Math.PI * 2;
    fin.position.z = -1.6;
    fin.rotation.z = angle;
    fin.translateY(0.85);
    group.add(fin);
  }

  // Animated flame.
  const flameGeo = new THREE.ConeGeometry(0.7, 3, 8);
  flameGeo.rotateX(-Math.PI / 2); // point toward -Z (behind the ship)
  const flameMat = new THREE.MeshBasicMaterial({
    color: 0xfacc15,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const flame = new THREE.Mesh(flameGeo, flameMat);
  flame.position.z = -2.6;
  flame.scale.set(0.4, 0.4, 0.4);
  group.add(flame);

  // Simple trail cylinder (stretched behind the engine).
  const trailGeo = new THREE.CylinderGeometry(0.4, 0.08, 1, 8);
  trailGeo.rotateX(Math.PI / 2);
  const trailMat = new THREE.MeshBasicMaterial({
    color: 0x67e8f9,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const trail = new THREE.Mesh(trailGeo, trailMat);
  trail.position.z = -3.0;
  trail.scale.set(1, 1, 0.1);
  group.add(trail);

  return { group, flame, trail, engine };
}
