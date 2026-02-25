// viewer-3dm.js – Rhino .3dm viewer using Rhino3dmLoader and CDN
// Three.js + Rhino3dmLoader docs: Rhino3dmLoader – three.js docs[web:91]

import * as THREE from "https://unpkg.com/three@0.161.0/build/three.module.js";
import { OrbitControls } from "https://unpkg.com/three@0.161.0/examples/jsm/controls/OrbitControls.js";
import { Rhino3dmLoader } from "https://unpkg.com/three@0.161.0/examples/jsm/loaders/3DMLoader.js";

let scene, renderer;
let orbitCamera, freeCamera, activeCamera;
let orbitControls;
let freeMode = false;

let keys = {};
let velocity = new THREE.Vector3();
const moveSpeed = 15.0;
const damping = 0.9;
let lastTime = performance.now();

function getModelFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const model = params.get("model");
  return model || "torpederas-valparaisoCLS.3dm";
}

init();
animate();

function init() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050608);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.outputEncoding = THREE.sRGBEncoding;
  document.body.appendChild(renderer.domElement);

  const aspect = w / h;

  orbitCamera = new THREE.PerspectiveCamera(60, aspect, 0.1, 5000);
  orbitCamera.position.set(60, 40, 60);

  freeCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 5000);
  freeCamera.position.set(0, 10, 40);

  activeCamera = orbitCamera;

  orbitControls = new OrbitControls(orbitCamera, renderer.domElement);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.08;
  orbitControls.screenSpacePanning = true;
  orbitControls.minDistance = 5;
  orbitControls.maxDistance = 2000;

  // Lighting
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x202020, 0.8);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(80, 120, 60);
  scene.add(dirLight);

  // Base ground (off for now)
  const groundGeo = new THREE.PlaneGeometry(3000, 3000);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x181822,
    roughness: 1.0,
    metalness: 0.0,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.visible = false;
  scene.add(ground);

  loadRhinoModel();

  window.addEventListener("resize", onWindowResize);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  renderer.domElement.addEventListener("click", () => {
    if (freeMode) {
      renderer.domElement.requestPointerLock();
    }
  });
  document.addEventListener("pointerlockchange", () => {});
  document.addEventListener("mousemove", onMouseMove);
}

function loadRhinoModel() {
  const loader = new Rhino3dmLoader();
  loader.setLibraryPath("https://unpkg.com/rhino3dm/"); // CDN for rhino3dm WASM[web:91][web:94]

  const modelFile = "models/" + getModelFromQuery();

  loader.load(
    modelFile,
    (object) => {
      // object is a THREE.Group containing meshes from Rhino geometry[web:91]
      object.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;

          let isGlass = false;
          const matName = (child.material && child.material.name) ? child.material.name.toLowerCase() : "";
          const layerName = (child.userData && child.userData.attributes && child.userData.attributes.layer)
            ? String(child.userData.attributes.layer).toLowerCase()
            : "";

          if (matName.includes("glass") || layerName.includes("glass") || layerName.includes("window")) {
            isGlass = true;
          }

          child.material = new THREE.MeshStandardMaterial({
            color: isGlass ? 0x8fb7ff : 0xf3f3f3,
            roughness: isGlass ? 0.05 : 0.55,
            metalness: 0.0,
            transparent: isGlass,
            opacity: isGlass ? 0.35 : 1.0,
          });
        }
      });

      scene.add(object);

      // Frame model
      const box = new THREE.Box3().setFromObject(object);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 10;

      const fitDistance = maxDim * 1.6;
      orbitCamera.position.copy(
        center.clone().add(new THREE.Vector3(fitDistance, fitDistance * 0.75, fitDistance))
      );
      orbitCamera.lookAt(center);
      orbitControls.target.copy(center);

      freeCamera.position.copy(
        center.clone().add(new THREE.Vector3(maxDim * 0.3, maxDim * 0.2, maxDim * 0.6))
      );
      freeCamera.lookAt(center);
    },
    undefined,
    (error) => {
      console.error("Error loading .3dm model:", error);
    }
  );
}

function onWindowResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  orbitCamera.aspect = w / h;
  orbitCamera.updateProjectionMatrix();

  freeCamera.aspect = w / h;
  freeCamera.updateProjectionMatrix();

  renderer.setSize(w, h);
}

function onKeyDown(event) {
  keys[event.code] = true;

  if (event.code === "KeyF") {
    freeMode = !freeMode;
    activeCamera = freeMode ? freeCamera : orbitCamera;

    if (!freeMode && document.pointerLockElement === renderer.domElement) {
      document.exitPointerLock();
    }
  }
}

function onKeyUp(event) {
  keys[event.code] = false;
}

function onMouseMove(event) {
  if (!freeMode) return;
  if (document.pointerLockElement !== renderer.domElement) return;

  const sensitivity = 0.0025;
  const yaw = -event.movementX * sensitivity;
  const pitch = -event.movementY * sensitivity;

  freeCamera.rotation.order = "YXZ";
  freeCamera.rotation.y += yaw;
  freeCamera.rotation.x += pitch;
  freeCamera.rotation.x = Math.max(
    -Math.PI / 2 + 0.01,
    Math.min(Math.PI / 2 - 0.01, freeCamera.rotation.x)
  );
}

function updateFreeCamera(delta) {
  velocity.multiplyScalar(damping);

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();

  freeCamera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();

  right.crossVectors(freeCamera.up, forward).normalize();

  const currentSpeed = moveSpeed;

  if (keys["KeyW"]) velocity.add(forward.multiplyScalar(currentSpeed * delta));
  if (keys["KeyS"]) velocity.add(forward.multiplyScalar(-currentSpeed * delta));
  if (keys["KeyA"]) velocity.add(right.multiplyScalar(currentSpeed * delta));
  if (keys["KeyD"]) velocity.add(right.multiplyScalar(-currentSpeed * delta));
  if (keys["Space"]) velocity.y += currentSpeed * delta;
  if (keys["ShiftLeft"] || keys["ShiftRight"]) velocity.y -= currentSpeed * delta;

  freeCamera.position.add(velocity);
}

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const delta = (now - lastTime) / 1000;
  lastTime = now;

  if (freeMode) {
    updateFreeCamera(delta);
  } else {
    orbitControls.update();
  }

  renderer.render(scene, activeCamera);
}
