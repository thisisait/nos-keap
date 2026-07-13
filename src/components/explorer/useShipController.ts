import { useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';

interface InputState {
  keys: Record<string, boolean>;
  mouse: { x: number; y: number };
}

interface ShipState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  quaternion: THREE.Quaternion;
  yaw: number;
  pitch: number;
  roll: number;
  speed: number;
  boosting: boolean;
  thrust: number;
}

const BASE_ACCEL = 140;
const BOOST_MULT = 2.2;
const MAX_SPEED = 240;
const MAX_BOOST_SPEED = 520;
const DRAG = 0.9;
const MOUSE_SENS = 0.0015;
const ROLL_RETURN = 5.0;
const ROLL_BANK = 0.6;

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _thrust = new THREE.Vector3();
const _euler = new THREE.Euler();
const _rollQ = new THREE.Quaternion();

export function useShipController(enabled: boolean) {
  const inputRef = useRef<InputState>({ keys: {}, mouse: { x: 0, y: 0 } });
  const shipRef = useRef<ShipState>({
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    yaw: 0,
    pitch: 0,
    roll: 0,
    speed: 0,
    boosting: false,
    thrust: 0,
  });

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    inputRef.current.keys[e.key.toLowerCase()] = true;
  }, []);

  const onKeyUp = useCallback((e: KeyboardEvent) => {
    inputRef.current.keys[e.key.toLowerCase()] = false;
  }, []);

  const onMouseMove = useCallback((e: MouseEvent) => {
    inputRef.current.mouse.x += e.movementX;
    inputRef.current.mouse.y += e.movementY;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousemove', onMouseMove);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('mousemove', onMouseMove);
    };
  }, [enabled, onKeyDown, onKeyUp, onMouseMove]);

  const reset = useCallback((position: THREE.Vector3, quaternion: THREE.Quaternion) => {
    const ship = shipRef.current;
    ship.position.copy(position);
    ship.velocity.set(0, 0, 0);
    ship.quaternion.copy(quaternion);
    ship.yaw = 0;
    ship.pitch = 0;
    ship.roll = 0;
    ship.speed = 0;
    ship.boosting = false;
    ship.thrust = 0;
    inputRef.current.keys = {};
    inputRef.current.mouse = { x: 0, y: 0 };

    // Derive yaw/pitch from the given quaternion so the ship looks the right way.
    _euler.setFromQuaternion(quaternion, 'YXZ');
    ship.yaw = _euler.y;
    ship.pitch = _euler.x;
  }, []);

  const tick = useCallback(
    (dt: number) => {
      const input = inputRef.current;
      const ship = shipRef.current;

      // Build local thrust vector.
      _thrust.set(0, 0, 0);
      if (input.keys['w']) _thrust.z += 1;
      if (input.keys['s']) _thrust.z -= 1;
      if (input.keys['d']) _thrust.x += 1;
      if (input.keys['a']) _thrust.x -= 1;
      if (input.keys['r']) _thrust.y += 1;
      if (input.keys['f']) _thrust.y -= 1;

      const rawThrust = _thrust.length();
      if (rawThrust > 0) _thrust.normalize();
      ship.thrust = Math.min(rawThrust, 1);
      ship.boosting = !!input.keys[' '];

      // Orientation from mouse.
      ship.yaw -= input.mouse.x * MOUSE_SENS;
      ship.pitch -= input.mouse.y * MOUSE_SENS;
      ship.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, ship.pitch));

      const mouseX = input.mouse.x;
      input.mouse.x = 0;
      input.mouse.y = 0;

      // Banking roll from yaw input and speed.
      const speedRatio = Math.min(ship.speed / MAX_SPEED, 1);
      const targetRoll = -mouseX * MOUSE_SENS * ROLL_BANK * (1 + speedRatio);
      ship.roll = THREE.MathUtils.lerp(ship.roll, targetRoll, 1 - Math.exp(-ROLL_RETURN * dt));

      // Compose yaw/pitch quaternion, then roll around the local forward axis.
      _euler.set(ship.pitch, ship.yaw, 0, 'YXZ');
      ship.quaternion.setFromEuler(_euler);
      _forward.set(0, 0, 1).applyQuaternion(ship.quaternion);
      _rollQ.setFromAxisAngle(_forward, ship.roll);
      ship.quaternion.multiply(_rollQ);

      // Transform thrust to world.
      _forward.set(0, 0, 1).applyQuaternion(ship.quaternion);
      _right.set(1, 0, 0).applyQuaternion(ship.quaternion);
      _up.set(0, 1, 0).applyQuaternion(ship.quaternion);

      const thrustWorld = new THREE.Vector3()
        .addScaledVector(_forward, _thrust.z)
        .addScaledVector(_right, _thrust.x)
        .addScaledVector(_up, _thrust.y);

      const boost = ship.boosting ? BOOST_MULT : 1.0;
      if (thrustWorld.lengthSq() > 0) {
        thrustWorld.normalize().multiplyScalar(BASE_ACCEL * boost * dt);
      }

      ship.velocity.add(thrustWorld);

      // Drag.
      ship.velocity.multiplyScalar(Math.exp(-DRAG * dt));

      // Clamp speed.
      const speed = ship.velocity.length();
      const limit = ship.boosting ? MAX_BOOST_SPEED : MAX_SPEED;
      if (speed > limit) {
        ship.velocity.multiplyScalar(limit / speed);
      }

      ship.speed = ship.velocity.length();

      // Move.
      ship.position.addScaledVector(ship.velocity, dt);
    },
    [],
  );

  return { shipRef, tick, reset, inputRef };
}
