(function() {
  'use strict';

  // ── Core scene objects ──────────────────────────────────────────────────
  let scene, renderer, orbitCamera, walkCamera, flyCamera, orthoCamera, activeCamera, orbitControls;
  let sun, hemi, fill;
  let cameraMode = 'orbit'; // 'orbit' | 'walk' | 'fly' | 'ortho'
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
  const WALK_HEIGHT = 1.7;

  // ── Visual style ────────────────────────────────────────────────────────
  let visualStyle = 'rendered';
  const meshMatCache = {};

  const LAYER_OVERRIDES = {
    glass: { color: 0xadd8f7, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.35 },
    window: { color: 0xadd8f7, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.35 },
    water: { color: 0x1a6fa8, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.75 },
    ocean: { color: 0x1a6fa8, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.75 },
    terrain: { color: 0x8a7560, roughness: 0.9, metalness: 0.0 },
    ground: { color: 0x8a7560, roughness: 0.9, metalness: 0.0 },
    metal: { color: 0x888888, roughness: 0.3, metalness: 0.85 },
    steel: { color: 0x888888, roughness: 0.3, metalness: 0.85 },
    concrete: { color: 0xb0a898, roughness: 0.85, metalness: 0.0 }
  };

  // ── Helpers ─────────────────────────────────────────────────────────────
  function getModelFromQuery() {
    const p = new URLSearchParams(window.location.search);
    return p.get('model') || 'torpederas-valparaisoCLS.3dm';
  }

  function showLoading(msg) {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.remove('hidden');
    const p = el.querySelector('p');
    if (p && msg) p.textContent = msg;
  }

  function hideLoading() {
    const el = document.getElementById('loading');
    if (el) el.classList.add('hidden');
  }

  // ── Environment updates ──────────────────────────────────────────────────
  function updateSun() {
    if (!sun) return;
    const az = parseFloat(document.getElementById('sun-az').value);
    const el = parseFloat(document.getElementById('sun-el').value);
    document.getElementById('az-val').textContent = az + '°';
    document.getElementById('el-val').textContent = el + '°';

    const phi = (90 - el) * (Math.PI / 180);
    const theta = (az + 180) * (Math.PI / 180);
    const dist = modelSpan * 2;

    sun.position.set(
      dist * Math.sin(phi) * Math.cos(theta),
      dist * Math.cos(phi),
      dist * Math.sin(phi) * Math.sin(theta)
    );
    
    // Adjust shadow camera to encompass the model
    const d = modelSpan * 1.5;
    sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
    sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
    sun.shadow.camera.updateProjectionMatrix();
  }

  function toggleShadows(enabled) {
    if (!renderer || !sun) return;
    sun.castShadow = enabled;
    if (modelGroup) {
      modelGroup.traverse(function(obj) {
        if (obj.isMesh) obj.castShadow = obj.receiveShadow = enabled;
      });
    }
  }

  // ── Camera mode UI ───────────────────────────────────────────────────────
  function updateModeUI() {
    const labels = { orbit: 'Orbit', walk: 'Walk', fly: 'Fly', ortho: 'Top View' };
    const el = document.getElementById('mode-label');
    if (el) el.textContent = labels[cameraMode] || cameraMode;
    document.querySelectorAll('.cam-btn').forEach(function(b) {
      b.classList.toggle('active', b.dataset.mode === cameraMode);
    });
    document.dispatchEvent(new CustomEvent('modchange', { detail: cameraMode }));
  }

  function setCameraMode(mode) {
    if (is2DModel && mode !== 'ortho') return;
    const prev = cameraMode;
    cameraMode = mode;
    if ((prev === 'walk' || prev === 'fly') && document.pointerLockElement) document.exitPointerLock();

    if (mode === 'orbit') {
      activeCamera = orbitCamera; orbitControls.enabled = true;
    } else if (mode === 'walk') {
      activeCamera = walkCamera; orbitControls.enabled = false;
      const target = orbitControls.target.clone();
      const groundY = getGroundY(target.x, target.z);
      walkCamera.position.set(target.x, groundY + WALK_HEIGHT, target.z + modelSpan * 0.1);
      walkCamera.rotation.set(0, 0, 0, 'YXZ'); yaw = 0; pitch = 0;
    } else if (mode === 'fly') {
      activeCamera = flyCamera; orbitControls.enabled = false;
      flyCamera.position.copy(orbitCamera.position);
      flyCamera.lookAt(orbitControls.target);
      yaw = flyCamera.rotation.y; pitch = flyCamera.rotation.x;
    } else if (mode === 'ortho') {
      activeCamera = orthoCamera; orbitControls.enabled = false; syncOrthoCamera();
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
    const origin = new THREE.Vector3(x, modelCenter.y + modelSpan * 2, z);
    raycaster.set(origin, downVec);
    const hits = raycaster.intersectObjects(groundMeshes, false);
    return hits.length > 0 ? hits[0].point.y : modelCenter.y;
  }

  function checkCollision(pos, radius) {
    if (groundMeshes.length === 0) return false;
    const dirs = [
      new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)
    ];
    for (let d of dirs) {
      raycaster.set(pos, d);
      const hits = raycaster.intersectObjects(groundMeshes, false);
      if (hits.length > 0 && hits[0].distance < radius) return true;
    }
    return false;
  }

  function resetCamera() {
    if (!modelGroup) return;
    if (cameraMode === 'orbit') {
      const d = modelSpan;
      orbitCamera.position.set(modelCenter.x + d * 1.4, modelCenter.y + d * 1.2, modelCenter.z + d * 1.4);
      orbitControls.target.copy(modelCenter);
      orbitControls.update();
    } else if (cameraMode === 'ortho') { syncOrthoCamera(); }
  }
  window.resetCamera = resetCamera;

  // ── Material helpers ─────────────────────────────────────────────────────
  function buildMatSet(hexColor, layerName) {
    const lname = (layerName || '').toLowerCase();
    let ovr = null;
    Object.keys(LAYER_OVERRIDES).forEach(function(k) {
      if (!ovr && lname.indexOf(k) !== -1) ovr = LAYER_OVERRIDES[k];
    });
    const rendParams = ovr ? Object.assign({ side: THREE.DoubleSide }, ovr)
                           : { color: hexColor, roughness: 0.72, metalness: 0.05, side: THREE.DoubleSide };
    const rendered = new THREE.MeshStandardMaterial(rendParams);
    const clay = new THREE.MeshStandardMaterial({ color: 0xd4c5b0, roughness: 0.75, metalness: 0.0, side: THREE.DoubleSide });
    const wireframe = new THREE.MeshStandardMaterial({ color: hexColor, wireframe: true, side: THREE.DoubleSide });
    const xray = new THREE.MeshStandardMaterial({ color: hexColor, transparent: true, opacity: 0.18, roughness: 0.3, metalness: 0.0, side: THREE.DoubleSide, depthWrite: false });
    return { rendered, clay, wireframe, xray };
  }

  function makeLineMat(hexColor) {
    return new THREE.LineBasicMaterial({ color: hexColor || 0x88aaff });
  }

  function applyStyle(style) {
    visualStyle = style;
    document.querySelectorAll('.style-btn').forEach(function(b) {
      b.classList.toggle('active', b.dataset.style === style);
    });
    if (!modelGroup) return;
    modelGroup.traverse(function(obj) {
      if (!obj.isMesh) return;
      const cache = meshMatCache[obj.uuid];
      if (!cache) return;
      obj.material = cache[style] || cache.rendered;
    });
  }
  window.applyStyle = applyStyle;

  // ── Rhino color utilities ────────────────────────────────────────────────
  function rhinoColorToHex(rc) {
    if (!rc) return 0xcccccc;
    if (typeof rc === 'number') return rc;
    const r = rc.r !== undefined ? rc.r : (rc[0] || 0);
    const g = rc.g !== undefined ? rc.g : (rc[1] || 0);
    const b = rc.b !== undefined ? rc.b : (rc[2] || 0);
    return (r << 16) | (g << 8) | b;
  }

  function getObjAppearance(obj, layerTable) {
    let hexColor = 0xcccccc;
    let layerName = '';
    try {
      const attrs = obj.attributes();
      if (!attrs) return { hexColor, layerName };
      const colorSrc = attrs.colorSource;
      if (colorSrc === 1 || colorSrc === 'object') {
        hexColor = rhinoColorToHex(attrs.objectColor || attrs.drawColor);
      } else {
        const layerIdx = attrs.layerIndex;
        if (layerTable && layerIdx !== undefined && layerIdx >= 0) {
          try {
            const layer = layerTable.get(layerIdx);
            if (layer) { layerName = layer.name || ''; hexColor = rhinoColorToHex(layer.color); }
          } catch(e) {}
        }
      }
    } catch(e) {}
    return { hexColor, layerName };
  }

  // ── Geometry conversion ──────────────────────────────────────────────────
  function rhinoGeomToThreeObjs(geom, rhino, appearance) {
    const results = [];
    const hex = appearance ? appearance.hexColor : 0xcccccc;
    const lname = appearance ? appearance.layerName : '';
    if (typeof geom.toThreejsJSON === 'function') {
      try {
        const json = geom.toThreejsJSON();
        const parsed = (typeof json === 'string') ? JSON.parse(json) : json;
        if (parsed && parsed.data && parsed.data.attributes) {
          const geo = new THREE.BufferGeometryLoader().parse(parsed);
          if (geo) {
            const matSet = buildMatSet(hex, lname);
            const mesh = new THREE.Mesh(geo, matSet[visualStyle] || matSet.rendered);
            meshMatCache[mesh.uuid] = matSet;
            results.push(mesh);
            return results;
          }
        }
      } catch(e) { console.warn('toThreejsJSON failed:', e.message); }
    }
    if (typeof geom.getMesh === 'function') {
      const meshTypes = [];
      try { meshTypes.push(rhino.MeshType.Any); } catch(e) {}
      try { meshTypes.push(rhino.MeshType.Default); } catch(e) {}
      try { meshTypes.push(rhino.MeshType.Render); } catch(e) {}
      meshTypes.push(0, 1, 2, 3, 4);
      for (let mi = 0; mi < meshTypes.length; mi++) {
        try {
          const rm = geom.getMesh(meshTypes[mi]);
          if (rm && typeof rm.toThreejsJSON === 'function') {
            const json = rm.toThreejsJSON();
            const parsed = (typeof json === 'string') ? JSON.parse(json) : json;
            if (parsed && parsed.data && parsed.data.attributes) {
              const geo = new THREE.BufferGeometryLoader().parse(parsed);
              if (geo) {
                const matSet = buildMatSet(hex, lname);
                const mesh = new THREE.Mesh(geo, matSet[visualStyle] || matSet.rendered);
                meshMatCache[mesh.uuid] = matSet;
                try { rm.delete(); } catch(e) {}
                results.push(mesh);
                return results;
              }
            }
            try { rm.delete(); } catch(e) {}
          }
        } catch(e) {}
      }
    }
    if (typeof geom.domain !== 'undefined' && typeof geom.pointAt === 'function') {
      try {
        const domain = geom.domain;
        const t0 = (domain && domain.min !== undefined) ? domain.min : 0;
        const t1 = (domain && domain.max !== undefined) ? domain.max : 1;
        if (t1 > t0) {
          const pts = [], steps = 80;
          for (let s = 0; s <= steps; s++) {
            const t = t0 + (t1 - t0) * (s / steps);
            try {
              const pt = geom.pointAt(t);
              if (pt && pt.length >= 3) pts.push(new THREE.Vector3(pt[0], pt[1], pt[2]));
            } catch(e) {}
          }
          if (pts.length >= 2) {
            const geo = new THREE.BufferGeometry().setFromPoints(pts);
            results.push(new THREE.Line(geo, makeLineMat(hex)));
            return results;
          }
        }
      } catch(e) { console.warn('Curve sampling failed:', e.message); }
    }
    if (typeof geom.location !== 'undefined') {
      try {
        const loc = geom.location;
        if (loc && loc.length >= 3) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute([loc[0], loc[1], loc[2]], 3));
          results.push(new THREE.Points(geo, new THREE.PointsMaterial({ color: hex, size: 0.5 })));
          return results;
        }
      } catch(e) {}
    }
    return results;
  }

  // ── Model loading ────────────────────────────────────────────────────────
  function loadModel() {
    const name = getModelFromQuery();
    showLoading('Downloading ' + name + '...');
    rhino3dm().then(async function(rhino) {
      try {
        const res = await fetch('models/' + name);
        if (!res.ok) throw new Error('HTTP ' + res.status + ': model not found');
        const buf = await res.arrayBuffer();
        showLoading('Parsing geometry...');
        const doc = rhino.File3dm.fromByteArray(new Uint8Array(buf));
        if (!doc) throw new Error('Could not parse Rhino document');
        let layerTable = null;
        try { layerTable = doc.layers(); } catch(e) {}
        const group = new THREE.Group();
        group.rotation.x = -Math.PI / 2;
        const objs = doc.objects();
        const total = objs.count;
        const shadowEnabled = document.getElementById('toggle-shadows').checked;
        for (let i = 0; i < total; i++) {
          try {
            const obj = objs.get(i); if (!obj) continue;
            const geom = obj.geometry(); if (!geom) continue;
            const appearance = getObjAppearance(obj, layerTable);
            const threeObjs = rhinoGeomToThreeObjs(geom, rhino, appearance);
            threeObjs.forEach(function(o) { 
              if (o.isMesh) {
                o.castShadow = o.receiveShadow = shadowEnabled;
              }
              group.add(o); 
            });
          } catch(e2) {}
        }
        doc.delete();
        if (group.children.length === 0) throw new Error('No renderable geometry found');
        let hasMesh = false;
        group.children.forEach(function(c) { if (c.isMesh) hasMesh = true; });
        is2DModel = !hasMesh;
        groundMeshes = [];
        group.traverse(function(c) { if (c.isMesh) groundMeshes.push(c); });
        scene.add(group);
        modelGroup = group;
        const box = new THREE.Box3().setFromObject(group);
        box.getCenter(modelCenter);
        box.getSize(modelSize);
        modelSpan = Math.max(modelSize.x, modelSize.y, modelSize.z) || 10;
        const d = modelSpan;
        orbitCamera.position.set(modelCenter.x + d * 1.4, modelCenter.y + d * 1.2, modelCenter.z + d * 1.4);
        orbitCamera.lookAt(modelCenter);
        orbitCamera.near = d * 0.001; orbitCamera.far = d * 300;
        orbitCamera.updateProjectionMatrix();
        orbitControls.target.copy(modelCenter);
        orbitControls.update();
        walkCamera.near = flyCamera.near = orbitCamera.near;
        walkCamera.far = flyCamera.far = orbitCamera.far;
        walkCamera.updateProjectionMatrix();
        flyCamera.position.copy(orbitCamera.position);
        flyCamera.lookAt(modelCenter);
        flyCamera.updateProjectionMatrix();
        yaw = flyCamera.rotation.y; pitch = flyCamera.rotation.x;
        syncOrthoCamera();
        setCameraMode(is2DModel ? 'ortho' : 'orbit');
        applyStyle(visualStyle);
        updateSun();
        hideLoading();
      } catch(e) {
        console.error(e);
        showLoading('Error: ' + e.message);
      }
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050608);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    document.body.appendChild(renderer.domElement);
    const aspect = window.innerWidth / window.innerHeight;
    orbitCamera = new THREE.PerspectiveCamera(50, aspect, 0.1, 1000000);
    orbitControls = new THREE.OrbitControls(orbitCamera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.08;
    orbitControls.maxPolarAngle = Math.PI * 0.88;
    orbitControls.minDistance = 0.5;
    walkCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000000);
    walkCamera.rotation.order = 'YXZ';
    flyCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000000);
    flyCamera.rotation.order = 'YXZ';
    orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000000);
    activeCamera = orbitCamera;
    hemi = new THREE.HemisphereLight(0xd6e4f0, 0x3a3020, 0.6);
    scene.add(hemi);
    sun = new THREE.DirectionalLight(0xfff5e0, 1.1);
    sun.position.set(20, 40, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.width = sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 10000;
    scene.add(sun);
    fill = new THREE.DirectionalLight(0x8899cc, 0.35);
    fill.position.set(-3, -1, -2);
    scene.add(fill);

    window.addEventListener('resize', function() {
      const w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h);
      const a = w / h;
      orbitCamera.aspect = walkCamera.aspect = flyCamera.aspect = a;
      orbitCamera.updateProjectionMatrix();
      walkCamera.updateProjectionMatrix();
      flyCamera.updateProjectionMatrix();
      syncOrthoCamera();
    });

    window.addEventListener('keydown', function(e) {
      keys[e.code] = true;
      if (e.code === 'Digit1') setCameraMode('orbit');
      if (e.code === 'Digit2') setCameraMode('walk');
      if (e.code === 'Digit3') setCameraMode('fly');
      if (e.code === 'Digit4') setCameraMode('ortho');
      if (e.code === 'KeyR') resetCamera();
      if (e.code === 'Space' && (cameraMode === 'walk' || cameraMode === 'fly')) e.preventDefault();
    });
    window.addEventListener('keyup', function(e) { keys[e.code] = false; });

    window.addEventListener('mousemove', function(e) {
      if (cameraMode !== 'walk' && cameraMode !== 'fly') return;
      if (document.pointerLockElement !== renderer.domElement) return;
      yaw -= e.movementX * 0.002;
      pitch -= e.movementY * 0.002;
      pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
      if (cameraMode === 'walk') walkCamera.rotation.set(pitch, yaw, 0, 'YXZ');
      else flyCamera.rotation.set(pitch, yaw, 0, 'YXZ');
    });

    renderer.domElement.addEventListener('click', function() {
      if (cameraMode === 'walk' || cameraMode === 'fly') renderer.domElement.requestPointerLock();
    });

    document.getElementById('sun-az').addEventListener('input', updateSun);
    document.getElementById('sun-el').addEventListener('input', updateSun);
    document.getElementById('toggle-shadows').addEventListener('change', function(e) {
      toggleShadows(e.target.checked);
    });

    let orthoDrag = false, orthoLast = { x: 0, y: 0 };
    renderer.domElement.addEventListener('mousedown', function(e) {
      if (cameraMode === 'ortho') { orthoDrag = true; orthoLast = { x: e.clientX, y: e.clientY }; }
    });
    window.addEventListener('mouseup', function() { orthoDrag = false; });
    window.addEventListener('mousemove', function(e) {
      if (!orthoDrag || cameraMode !== 'ortho') return;
      const dx = (e.clientX - orthoLast.x) / window.innerWidth * (orthoCamera.right - orthoCamera.left);
      const dz = (e.clientY - orthoLast.y) / window.innerHeight * (orthoCamera.top - orthoCamera.bottom);
      orthoCamera.position.x -= dx;
      orthoCamera.position.z += dz;
      orthoLast = { x: e.clientX, y: e.clientY };
    });
    renderer.domElement.addEventListener('wheel', function(e) {
      if (cameraMode !== 'ortho') return;
      const f = e.deltaY > 0 ? 1.1 : 0.9;
      orthoCamera.left *= f; orthoCamera.right *= f;
      orthoCamera.top *= f; orthoCamera.bottom *= f;
      orthoCamera.updateProjectionMatrix();
    }, { passive: true });

    document.querySelectorAll('.cam-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { setCameraMode(btn.dataset.mode); });
    });
    document.querySelectorAll('.style-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { applyStyle(btn.dataset.style); });
    });

    loadModel();

    (function anim() {
      requestAnimationFrame(anim);
      const spd = modelSpan * 0.003;
      const radius = 0.4;

      if (cameraMode === 'walk') {
        const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
        const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
        const move = new THREE.Vector3();
        if (keys['KeyW']) move.add(forward);
        if (keys['KeyS']) move.addScaledVector(forward, -1);
        if (keys['KeyA']) move.addScaledVector(right, -1);
        if (keys['KeyD']) move.add(right);
        
        if (move.lengthSq() > 0) velocity.addScaledVector(move.normalize(), spd);
        velocity.multiplyScalar(damping);

        const nextPos = walkCamera.position.clone().add(velocity);
        const groundY = getGroundY(nextPos.x, nextPos.z);
        nextPos.y = groundY + WALK_HEIGHT;

        if (!checkCollision(nextPos, radius)) {
          walkCamera.position.copy(nextPos);
        } else {
          velocity.set(0, 0, 0);
        }
      } else if (cameraMode === 'fly') {
        const f = new THREE.Vector3(), r = new THREE.Vector3();
        flyCamera.getWorldDirection(f);
        r.crossVectors(f, flyCamera.up).normalize();
        const move = new THREE.Vector3();
        if (keys['KeyW']) move.add(f);
        if (keys['KeyS']) move.addScaledVector(f, -1);
        if (keys['KeyA']) move.addScaledVector(r, -1);
        if (keys['KeyD']) move.add(r);
        if (keys['Space']) move.y += 1;
        if (keys['ShiftLeft'] || keys['ShiftRight']) move.y -= 1;

        if (move.lengthSq() > 0) velocity.addScaledVector(move.normalize(), spd);
        velocity.multiplyScalar(damping);

        const nextPos = flyCamera.position.clone().add(velocity);
        if (!checkCollision(nextPos, radius)) {
          flyCamera.position.copy(nextPos);
        } else {
          velocity.set(0, 0, 0);
        }
      } else if (cameraMode === 'orbit') {
        orbitControls.update();
      }
      renderer.render(scene, activeCamera);
    })();
  }
  init();
})();
