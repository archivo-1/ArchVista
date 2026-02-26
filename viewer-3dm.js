(function() {
  'use strict';

  // ── Core scene objects ──────────────────────────────────────────────────
  let scene, renderer, orbitCamera, walkCamera, flyCamera, orthoCamera, activeCamera, orbitControls;
  let cameraMode = 'orbit'; 
  let is2DModel = false;
  let modelGroup = null;
  let groundMeshes = [];
  let modelCenter = new THREE.Vector3();
  let modelSize = new THREE.Vector3();
  let modelSpan = 10;
  const raycaster = new THREE.Raycaster();
  const downVec = new THREE.Vector3(0, -1, 0);
  const keys = {};
  const velocity = new THREE.Vector3();
  const damping = 0.85;
  let yaw = 0, pitch = 0;
  const WALK_HEIGHT = 1.85; // Slightly higher to avoid terrain clipping
  const COLLISION_DISTANCE = 0.8;

  // ── Visual style ────────────────────────────────────────────────────────
  let visualStyle = 'rendered';
  const meshMatCache = {};

  const LAYER_OVERRIDES = {
    glass:     { color: 0xadd8f7, roughness: 0.05, metalness: 0.1,  transparent: true, opacity: 0.35 },
    window:    { color: 0xadd8f7, roughness: 0.05, metalness: 0.1,  transparent: true, opacity: 0.35 },
    water:     { color: 0x1a6fa8, roughness: 0.1,  metalness: 0.3,  transparent: true, opacity: 0.75, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 },
    ocean:     { color: 0x1a6fa8, roughness: 0.1,  metalness: 0.3,  transparent: true, opacity: 0.75, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 },
    terrain:   { color: 0x8a7560, roughness: 0.9,  metalness: 0.0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 },
    ground:    { color: 0x8a7560, roughness: 0.9,  metalness: 0.0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 },
    metal:     { color: 0x888888, roughness: 0.3,  metalness: 0.85 },
    concrete:  { color: 0xb0a898, roughness: 0.85, metalness: 0.0 }
  };

  // ── Sun System ──────────────────────────────────────────────────────────
  let sunLight, sunPos = { azimuth: 45, altitude: 45 }, sunIntensity = 1.1;

  function updateSun() {
    if (!sunLight) return;
    const phi = (90 - sunPos.altitude) * (Math.PI / 180);
    const theta = (sunPos.azimuth) * (Math.PI / 180);
    const d = modelSpan * 2;
    sunLight.position.set(d * Math.sin(phi) * Math.cos(theta), d * Math.cos(phi), d * Math.sin(phi) * Math.sin(theta));
    sunLight.intensity = sunIntensity;
  }

  window.setSunAzimuth = function(v) { sunPos.azimuth = parseFloat(v); updateSun(); };
  window.setSunAltitude = function(v) { sunPos.altitude = parseFloat(v); updateSun(); };
  window.setSunIntensity = function(v) { sunIntensity = parseFloat(v); updateSun(); };

  // ── Helpers ─────────────────────────────────────────────────────────────
  function getModelFromQuery() {
    const p = new URLSearchParams(window.location.search);
    return p.get('model') || 'torpederas-valparaisoCLS.3dm';
  }

  function showLoading(msg) {
    const el = document.getElementById('loading');
    if (el) {
      el.classList.remove('hidden');
      const p = el.querySelector('p');
      if (p && msg) p.textContent = msg;
    }
  }

  function hideLoading() {
    const el = document.getElementById('loading');
    if (el) el.classList.add('hidden');
  }

  function updateModeUI() {
    const labels = { orbit: 'Orbit', walk: 'Walk', fly: 'Fly', ortho: 'Top View' };
    const el = document.getElementById('mode-label');
    if (el) el.textContent = labels[cameraMode] || cameraMode;
    document.querySelectorAll('.cam-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === cameraMode));
    document.dispatchEvent(new CustomEvent('modchange', { detail: cameraMode }));
  }

  function setCameraMode(mode) {
    if (is2DModel && mode !== 'ortho') return;
    const prev = cameraMode;
    cameraMode = mode;
    if ((prev === 'walk' || prev === 'fly') && document.pointerLockElement) document.exitPointerLock();

    if (mode === 'orbit') {
      activeCamera = orbitCamera;
      orbitControls.enabled = true;
    } else if (mode === 'walk') {
      activeCamera = walkCamera;
      orbitControls.enabled = false;
      const target = orbitControls.target.clone();
      const gy = getGroundY(target.x, target.z);
      walkCamera.position.set(target.x, gy + WALK_HEIGHT, target.z + modelSpan * 0.02);
      walkCamera.rotation.set(0, 0, 0, 'YXZ');
      yaw = 0; pitch = 0;
    } else if (mode === 'fly') {
      activeCamera = flyCamera;
      orbitControls.enabled = false;
      flyCamera.position.copy(orbitCamera.position);
      flyCamera.lookAt(orbitControls.target);
      yaw = flyCamera.rotation.y; pitch = flyCamera.rotation.x;
    } else if (mode === 'ortho') {
      activeCamera = orthoCamera;
      orbitControls.enabled = false;
      syncOrthoCamera();
    }
    velocity.set(0, 0, 0);
    updateModeUI();
  }

  function syncOrthoCamera() {
    if (!orthoCamera) return;
    const aspect = window.innerWidth / window.innerHeight;
    const halfH = modelSpan * 0.7, halfW = halfH * aspect;
    orthoCamera.left = -halfW; orthoCamera.right = halfW;
    orthoCamera.top = halfH; orthoCamera.bottom = -halfH;
    orthoCamera.position.set(modelCenter.x, modelCenter.y + modelSpan * 5, modelCenter.z);
    orthoCamera.lookAt(modelCenter);
    orthoCamera.updateProjectionMatrix();
  }

  function getGroundY(x, z) {
    if (groundMeshes.length === 0) return modelCenter.y;
    // Cast from high above
    const origin = new THREE.Vector3(x, modelCenter.y + modelSpan * 3, z);
    raycaster.set(origin, downVec);
    const hits = raycaster.intersectObjects(groundMeshes, false);
    return hits.length > 0 ? hits[0].point.y : modelCenter.y;
  }

  function checkCollision(pos, dir, dist) {
    if (!modelGroup) return false;
    raycaster.set(pos, dir);
    const hits = raycaster.intersectObjects(modelGroup.children, true);
    for (let hit of hits) {
      if (hit.distance < dist) return true;
    }
    return false;
  }

  function resetCamera() {
    if (!modelGroup) return;
    if (cameraMode === 'orbit') {
      const d = modelSpan;
      orbitCamera.position.set(modelCenter.x + d * 1.5, modelCenter.y + d * 1.3, modelCenter.z + d * 1.5);
      orbitControls.target.copy(modelCenter);
      orbitControls.update();
    } else if (cameraMode === 'ortho') syncOrthoCamera();
  }
  window.resetCamera = resetCamera;

  function buildLayersPanel(doc) {
    const list = document.getElementById('layer-list');
    if (!list) return;
    list.innerHTML = '';
    const layers = doc.layers();
    for (let i = 0; i < layers.count; i++) {
      const L = layers.get(i);
      const row = document.createElement('div'); row.className = 'layer-row';
      const toggle = document.createElement('div'); toggle.className = 'layer-toggle';
      toggle.onclick = (e) => {
        e.stopPropagation();
        const isOff = toggle.classList.toggle('off');
        modelGroup.traverse(obj => { if (obj.userData && obj.userData.layerIndex === i) obj.visible = !isOff; });
      };
      const name = document.createElement('div'); name.className = 'layer-name'; name.textContent = L.name || ('Layer ' + i);
      row.appendChild(toggle); row.appendChild(name); list.appendChild(row);
    }
  }

  function buildMatSet(hexColor, layerName) {
    const lname = (layerName || '').toLowerCase();
    let ovr = null;
    Object.keys(LAYER_OVERRIDES).forEach(k => { if (!ovr && lname.indexOf(k) !== -1) ovr = LAYER_OVERRIDES[k]; });

    // Try to avoid Z-fighting by disabling DoubleSide for non-transparent objects
    const side = (ovr && ovr.transparent) ? THREE.DoubleSide : THREE.FrontSide;
    const rendParams = Object.assign({ side: side, color: hexColor, roughness: 0.75, metalness: 0.05 }, ovr || {});
    
    return {
      rendered: new THREE.MeshStandardMaterial(rendParams),
      clay: new THREE.MeshStandardMaterial({ color: 0xd4c5b0, roughness: 0.8, metalness: 0.0, side: THREE.FrontSide }),
      wireframe: new THREE.MeshStandardMaterial({ color: hexColor, wireframe: true }),
      xray: new THREE.MeshStandardMaterial({ color: hexColor, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false })
    };
  }

  function rhinoGeomToThreeObjs(geom, rhino, appearance) {
    const results = [];
    const hex = appearance.hexColor, lname = appearance.layerName, lidx = appearance.layerIndex;
    const tag = (o) => { o.userData = { layerIndex: lidx }; return o; };

    if (typeof geom.toThreejsJSON === 'function') {
      try {
        const json = geom.toThreejsJSON();
        const parsed = (typeof json === 'string') ? JSON.parse(json) : json;
        if (parsed && parsed.data && parsed.data.attributes) {
          const geo = new THREE.BufferGeometryLoader().parse(parsed);
          const matSet = buildMatSet(hex, lname);
          const mesh = tag(new THREE.Mesh(geo, matSet[visualStyle] || matSet.rendered));
          meshMatCache[mesh.uuid] = matSet;
          results.push(mesh); return results;
        }
      } catch(e) {}
    }

    if (typeof geom.getMesh === 'function') {
      const types = [rhino.MeshType.Any, rhino.MeshType.Default, 0, 1];
      for (let t of types) {
        try {
          const rm = geom.getMesh(t);
          if (rm) {
            const geo = new THREE.BufferGeometryLoader().parse(JSON.parse(rm.toThreejsJSON()));
            const matSet = buildMatSet(hex, lname);
            const mesh = tag(new THREE.Mesh(geo, matSet[visualStyle] || matSet.rendered));
            meshMatCache[mesh.uuid] = matSet;
            rm.delete(); results.push(mesh); return results;
          }
        } catch(e) {}
      }
    }

    if (typeof geom.pointAt === 'function') {
      try {
        const pts = [], steps = 60, d = geom.domain;
        for (let s = 0; s <= steps; s++) {
          const p = geom.pointAt(d.min + (d.max - d.min) * (s / steps));
          pts.push(new THREE.Vector3(p[0], p[1], p[2]));
        }
        results.push(tag(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: hex }))));
      } catch(e) {}
    }
    return results;
  }

  function loadModel() {
    const name = getModelFromQuery();
    showLoading('Downloading ' + name + '...');
    rhino3dm().then(async function(rhino) {
      try {
        const res = await fetch('models/' + name);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = await res.arrayBuffer();
        showLoading('Parsing geometry...');
        const doc = rhino.File3dm.fromByteArray(new Uint8Array(buf));
        const group = new THREE.Group(); group.rotation.x = -Math.PI / 2;
        
        const layers = doc.layers(), objs = doc.objects();
        for (let i = 0; i < objs.count; i++) {
          try {
            const o = objs.get(i);
            const app = getObjAppearance(o, layers);
            rhinoGeomToThreeObjs(o.geometry(), rhino, app).forEach(three => group.add(three));
          } catch(e) {}
        }
        buildLayersPanel(doc); doc.delete();
        if (group.children.length === 0) throw new Error('Empty model');
        
        groundMeshes = []; group.traverse(c => { if (c.isMesh) groundMeshes.push(c); });
        scene.add(group); modelGroup = group;
        const box = new THREE.Box3().setFromObject(group);
        box.getCenter(modelCenter); box.getSize(modelSize);
        modelSpan = Math.max(modelSize.x, modelSize.y, modelSize.z) || 10;
        
        // ── Camera planes logic ──
        const near = Math.max(1.5, modelSpan * 0.0005);
        const far = modelSpan * 20;
        [orbitCamera, walkCamera, flyCamera].forEach(c => { c.near = near; c.far = far; c.updateProjectionMatrix(); });
        orthoCamera.near = near; orthoCamera.far = far;

        resetCamera(); updateSun(); setCameraMode(groundMeshes.length === 0 ? 'ortho' : 'orbit'); hideLoading();
      } catch(e) { showLoading('Error: ' + e.message); }
    });
  }

  function init() {
    scene = new THREE.Scene(); scene.background = new THREE.Color(0x050608);
    renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio); renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping; document.body.appendChild(renderer.domElement);

    const aspect = window.innerWidth / window.innerHeight;
    orbitCamera = new THREE.PerspectiveCamera(50, aspect, 1, 10000);
    orbitControls = new THREE.OrbitControls(orbitCamera, renderer.domElement); orbitControls.enableDamping = true;
    walkCamera = new THREE.PerspectiveCamera(75, aspect, 1, 10000); walkCamera.rotation.order = 'YXZ';
    flyCamera = new THREE.PerspectiveCamera(75, aspect, 1, 10000); flyCamera.rotation.order = 'YXZ';
    orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 10000);
    activeCamera = orbitCamera;

    scene.add(new THREE.HemisphereLight(0xd6e4f0, 0x3a3020, 0.6));
    sunLight = new THREE.DirectionalLight(0xfff5e0, 1.1); scene.add(sunLight);
    scene.add(new THREE.DirectionalLight(0x8899cc, 0.35));

    window.addEventListener('resize', () => {
      const w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h);
      orbitCamera.aspect = walkCamera.aspect = flyCamera.aspect = w / h;
      [orbitCamera, walkCamera, flyCamera].forEach(c => c.updateProjectionMatrix());
      syncOrthoCamera();
    });

    window.addEventListener('keydown', e => {
      keys[e.code] = true;
      if (e.code.startsWith('Digit')) {
        const m = ['orbit','walk','fly','ortho'][parseInt(e.code.slice(-1))-1];
        if (m) setCameraMode(m);
      }
      if (e.code === 'KeyR') resetCamera();
    });
    window.addEventListener('keyup', e => { keys[e.code] = false; });

    window.addEventListener('mousemove', e => {
      if ((cameraMode !== 'walk' && cameraMode !== 'fly') || document.pointerLockElement !== renderer.domElement) return;
      yaw -= e.movementX * 0.0022; pitch -= e.movementY * 0.0022;
      pitch = Math.max(-1.5, Math.min(1.5, pitch));
      (cameraMode === 'walk' ? walkCamera : flyCamera).rotation.set(pitch, yaw, 0, 'YXZ');
    });

    renderer.domElement.onclick = () => { if (cameraMode === 'walk' || cameraMode === 'fly') renderer.domElement.requestPointerLock(); };

    loadModel();

    (function anim() {
      requestAnimationFrame(anim);
      const spd = modelSpan * 0.003;
      if (cameraMode === 'walk' || cameraMode === 'fly') {
        const cam = cameraMode === 'walk' ? walkCamera : flyCamera;
        const f = new THREE.Vector3(), r = new THREE.Vector3();
        cam.getWorldDirection(f); if (cameraMode === 'walk') f.y = 0; f.normalize();
        r.crossVectors(f, cam.up).normalize();
        
        const move = new THREE.Vector3();
        if (keys['KeyW']) move.addScaledVector(f, spd);
        if (keys['KeyS']) move.addScaledVector(f, -spd);
        if (keys['KeyA']) move.addScaledVector(r, -spd);
        if (keys['KeyD']) move.addScaledVector(r, spd);
        if (cameraMode === 'fly') {
          if (keys['Space']) move.y += spd;
          if (keys['ShiftLeft']) move.y -= spd;
        }

        if (move.lengthSq() > 0) {
          if (!checkCollision(cam.position, move.clone().normalize(), COLLISION_DISTANCE * 2)) {
            velocity.add(move);
          }
        }
        
        velocity.multiplyScalar(damping);
        cam.position.add(velocity);
        
        if (cameraMode === 'walk') {
          const gy = getGroundY(cam.position.x, cam.position.z);
          const targetY = gy + WALK_HEIGHT;
          cam.position.y += (targetY - cam.position.y) * 0.2;
        }
      } else if (cameraMode === 'orbit') orbitControls.update();
      renderer.render(scene, activeCamera);
    })();
  }
  
  function getObjAppearance(obj, layerTable) {
    let hexColor = 0xcccccc, layerName = '', layerIndex = -1;
    try {
      const attrs = obj.attributes(); if (!attrs) return { hexColor, layerName, layerIndex };
      layerIndex = attrs.layerIndex;
      if (attrs.colorSource === 1 || attrs.colorSource === 'object') {
        hexColor = rhinoColorToHex(attrs.objectColor || attrs.drawColor);
      } else if (layerTable && layerIndex >= 0) {
        try {
          const layer = layerTable.get(layerIndex);
          if (layer) { layerName = layer.name || ''; hexColor = rhinoColorToHex(layer.color); }
        } catch(e) {}
      }
    } catch(e) {}
    return { hexColor, layerName, layerIndex };
  }
  
  init();
})();
