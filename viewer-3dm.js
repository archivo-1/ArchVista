(function() {
    'use strict';

    // ── Core scene objects ──────────────────────────────────────────────────
    let scene, renderer, orbitCamera, walkCamera, flyCamera, orthoCamera, activeCamera, orbitControls;
    let sun, hemi, fill;
    let cameraMode = 'orbit'; // 'orbit' | 'walk' | 'fly' | 'ortho'
    let isOrthoOrbit = false;
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

    // ── Layers state ────────────────────────────────────────────────────────
    const layerMeshes = {}; // layerName -> Mesh[]

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

    // ── Environment & Background ─────────────────────────────────────────────
    function updateSun() {
        if (!sun) return;
        const az = parseFloat(document.getElementById('sun-az').value);
        const el = parseFloat(document.getElementById('sun-el').value);
        document.getElementById('az-val').textContent = az + '°';
        document.getElementById('el-val').textContent = el + '°';
        const phi = (90 - el) * (Math.PI / 180);
        const theta = (az + 180) * (Math.PI / 180);
        const dist = modelSpan * 2.5;
        sun.position.set(
            modelCenter.x + dist * Math.sin(phi) * Math.cos(theta),
            modelCenter.y + dist * Math.cos(phi),
            modelCenter.z + dist * Math.sin(phi) * Math.sin(theta)
        );
        sun.target.position.copy(modelCenter);
        sun.target.updateMatrixWorld();
        const d = modelSpan * 1.5;
        sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
        sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
        sun.shadow.camera.updateProjectionMatrix();
    }

    function changeBackground(type) {
        if (!scene) return;
        if (type === 'black') scene.background = new THREE.Color(0x050608);
        else if (type === 'white') scene.background = new THREE.Color(0xffffff);
        else if (type === 'grey') scene.background = new THREE.Color(0x22262e);
        else if (type === 'sky' || type === 'gradient') {
            const canvas = document.createElement('canvas');
            canvas.width = 2; canvas.height = 512;
            const ctx = canvas.getContext('2d');
            const grad = ctx.createLinearGradient(0, 0, 0, 512);
            if (type === 'sky') {
                grad.addColorStop(0, '#0f172a'); // Deep space
                grad.addColorStop(1, '#3b82f6'); // Blue horizon
            } else {
                grad.addColorStop(0, '#020617');
                grad.addColorStop(1, '#1e293b');
            }
            ctx.fillStyle = grad; ctx.fillRect(0, 0, 2, 512);
            const tex = new THREE.CanvasTexture(canvas);
            scene.background = tex;
        }
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
            activeCamera = isOrthoOrbit ? orthoCamera : orbitCamera;
            orbitControls.object = activeCamera;
            orbitControls.enabled = true;
        } else if (mode === 'walk') {
            activeCamera = walkCamera;
            orbitControls.enabled = false;
            const target = orbitControls.target.clone();
            const groundY = getGroundY(target.x, target.z);
            walkCamera.position.set(target.x, groundY + WALK_HEIGHT, target.z + modelSpan * 0.05);
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

    function toggleOrtho() {
        isOrthoOrbit = !isOrthoOrbit;
        const btn = document.getElementById('ortho-toggle');
        if (btn) btn.classList.toggle('active', isOrthoOrbit);
        
        if (cameraMode === 'orbit') {
            activeCamera = isOrthoOrbit ? orthoCamera : orbitCamera;
            if (isOrthoOrbit) syncOrthoCamera();
            orbitControls.object = activeCamera;
            orbitControls.update();
        }
    }

    function syncOrthoCamera() {
        if (!orthoCamera) return;
        const aspect = window.innerWidth / window.innerHeight;
        const halfH = modelSpan * 0.7, halfW = halfH * aspect;
        orthoCamera.left = -halfW; orthoCamera.right = halfW;
        orthoCamera.top = halfH; orthoCamera.bottom = -halfH;
        
        if (cameraMode === 'orbit' && isOrthoOrbit) {
            // Match perspective camera position but look at target
            const dir = new THREE.Vector3().subVectors(orbitCamera.position, orbitControls.target).normalize();
            orthoCamera.position.copy(orbitControls.target).addScaledVector(dir, modelSpan * 5);
            orthoCamera.lookAt(orbitControls.target);
        } else {
            orthoCamera.position.set(modelCenter.x, modelCenter.y + modelSpan * 5, modelCenter.z);
            orthoCamera.lookAt(modelCenter);
        }
        orthoCamera.updateProjectionMatrix();
    }

    function getGroundY(x, z) {
        if (groundMeshes.length === 0) return modelCenter.y;
        const origin = new THREE.Vector3(x, modelCenter.y + modelSpan * 5, z);
        raycaster.set(origin, downVec);
        const hits = raycaster.intersectObjects(groundMeshes, false);
        return hits.length > 0 ? hits[0].point.y : modelCenter.y;
    }

    function checkCollision(pos, radius) {
        if (groundMeshes.length === 0) return false;
        const dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
        const heights = [0.5, WALK_HEIGHT, WALK_HEIGHT * 0.8];
        for (let h of heights) {
            const p = pos.clone(); p.y = pos.y - WALK_HEIGHT + h;
            for (let d of dirs) {
                raycaster.set(p, d);
                const hits = raycaster.intersectObjects(groundMeshes, false);
                if (hits.length > 0 && hits[0].distance < radius) return true;
            }
        }
        return false;
    }

    function resetCamera() {
        if (!modelGroup) return;
        isOrthoOrbit = false;
        const btn = document.getElementById('ortho-toggle');
        if (btn) btn.classList.remove('active');
        
        if (cameraMode === 'orbit' || cameraMode === 'ortho') {
            const d = modelSpan;
            orbitCamera.position.set(modelCenter.x + d * 1.4, modelCenter.y + d * 1.2, modelCenter.z + d * 1.4);
            orbitControls.target.copy(modelCenter);
            activeCamera = orbitCamera;
            orbitControls.object = activeCamera;
            orbitControls.update();
            if (cameraMode === 'ortho') syncOrthoCamera();
        }
    }
    window.resetCamera = resetCamera;

    // ── Material helpers ─────────────────────────────────────────────────────
    function buildMatSet(hexColor, layerName) {
        const lname = (layerName || '').toLowerCase();
        let ovr = null;
        Object.keys(LAYER_OVERRIDES).forEach(function(k) {
            if (!ovr && lname.indexOf(k) !== -1) ovr = LAYER_OVERRIDES[k];
        });
        const rendParams = ovr ? Object.assign({ side: THREE.DoubleSide }, ovr) : { color: hexColor, roughness: 0.72, metalness: 0.05, side: THREE.DoubleSide };
        rendParams.polygonOffset = true; rendParams.polygonOffsetFactor = 1; rendParams.polygonOffsetUnits = 1;
        const rendered = new THREE.MeshStandardMaterial(rendParams);
        const clay = new THREE.MeshStandardMaterial({ color: 0xd4c5b0, roughness: 0.75, metalness: 0.0, side: THREE.DoubleSide });
        const wireframe = new THREE.MeshStandardMaterial({ color: hexColor, wireframe: true, side: THREE.DoubleSide });
        const xray = new THREE.MeshStandardMaterial({ color: hexColor, transparent: true, opacity: 0.18, roughness: 0.3, metalness: 0.0, side: THREE.DoubleSide, depthWrite: false });
        return { rendered, clay, wireframe, xray };
    }

    function makeLineMat(hexColor) { return new THREE.LineBasicMaterial({ color: hexColor || 0x88aaff }); }

    function applyStyle(style) {
        visualStyle = style;
        document.querySelectorAll('.style-btn').forEach(b => b.classList.toggle('active', b.dataset.style === style));
        if (!modelGroup) return;
        modelGroup.traverse(obj => {
            if (!obj.isMesh) return;
            const cache = meshMatCache[obj.uuid];
            if (cache) obj.material = cache[style] || cache.rendered;
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

    function getObjAppearance(obj, doc) {
        let hexColor = 0xcccccc, layerName = 'Default';
        try {
            const attrs = obj.attributes();
            const layerIdx = attrs.layerIndex;
            const layerTable = doc.layers();
            if (layerIdx >= 0 && layerTable) {
                const layer = layerTable.get(layerIdx);
                if (layer) {
                    layerName = layer.name || 'Default';
                    if (attrs.colorSource === 1 || attrs.colorSource === 'object') {
                        hexColor = rhinoColorToHex(attrs.objectColor || attrs.drawColor);
                    } else {
                        hexColor = rhinoColorToHex(layer.color);
                    }
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
                    const matSet = buildMatSet(hex, lname);
                    const mesh = new THREE.Mesh(geo, matSet[visualStyle] || matSet.rendered);
                    meshMatCache[mesh.uuid] = matSet;
                    results.push(mesh);
                    return results;
                }
            } catch(e) {}
        }
        if (typeof geom.getMesh === 'function') {
            const types = [rhino.MeshType.Any, rhino.MeshType.Render, rhino.MeshType.Default];
            for (let t of types) {
                try {
                    const rm = geom.getMesh(t);
                    if (rm) {
                        const geo = new THREE.BufferGeometryLoader().parse(JSON.parse(rm.toThreejsJSON()));
                        const matSet = buildMatSet(hex, lname);
                        const mesh = new THREE.Mesh(geo, matSet[visualStyle] || matSet.rendered);
                        meshMatCache[mesh.uuid] = matSet;
                        results.push(mesh);
                        rm.delete(); return results;
                    }
                } catch(e) {}
            }
        }
        if (geom.domain && typeof geom.pointAt === 'function') {
            const pts = [], steps = 100, d = geom.domain;
            for (let i = 0; i <= steps; i++) {
                const t = d[0] + (d[1] - d[0]) * (i / steps);
                const p = geom.pointAt(t); pts.push(new THREE.Vector3(p[0], p[1], p[2]));
            }
            results.push(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), makeLineMat(hex)));
        }
        return results;
    }

    // ── Layers Panel UI ─────────────────────────────────────────────────────
    function updateLayersUI() {
        const list = document.getElementById('layers-list');
        if (!list) return;
        list.innerHTML = '';
        const sorted = Object.keys(layerMeshes).sort();
        sorted.forEach(name => {
            const row = document.createElement('label');
            row.className = 'layer-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.checked = true;
            cb.onchange = () => {
                layerMeshes[name].forEach(m => m.visible = cb.checked);
            };
            row.appendChild(cb);
            row.appendChild(document.createTextNode(name));
            list.appendChild(row);
        });
    }

    // ── Model processing ─────────────────────────────────────────────────────
    function processDocObjects(doc, rhino, shadowEnabled) {
        const mainGroup = new THREE.Group();
        const objs = doc.objects();
        const idefs = doc.instanceDefinitions();
        
        // Reset layers
        for (let k in layerMeshes) delete layerMeshes[k];

        function recurse(obj, parentGroup) {
            const geom = obj.geometry();
            if (!geom) return;
            
            if (rhino.ObjectType && geom.objectType === rhino.ObjectType.InstanceReference) {
                const idef = idefs.findId(geom.parentIdefId);
                if (idef) {
                    const blockGroup = new THREE.Group();
                    idef.getObjectIds().forEach(uuid => {
                        const childObj = doc.objects().findId(uuid);
                        if (childObj) recurse(childObj, blockGroup);
                    });
                    blockGroup.applyMatrix4(new THREE.Matrix4().fromArray(geom.xform.toArray()));
                    parentGroup.add(blockGroup);
                }
            } else {
                const appearance = getObjAppearance(obj, doc);
                const threeObjs = rhinoGeomToThreeObjs(geom, rhino, appearance);
                threeObjs.forEach(o => {
                    if (o.isMesh) o.castShadow = o.receiveShadow = shadowEnabled;
                    parentGroup.add(o);
                    // Add to layers tracking
                    const lname = appearance.layerName;
                    if (!layerMeshes[lname]) layerMeshes[lname] = [];
                    layerMeshes[lname].push(o);
                });
            }
        }
        for (let i = 0; i < objs.count; i++) recurse(objs.get(i), mainGroup);
        updateLayersUI();
        return mainGroup;
    }

    function loadModel() {
        const name = getModelFromQuery();
        showLoading('Downloading ' + name + '...');
        rhino3dm().then(async function(rhino) {
            try {
                const res = await fetch('models/' + name);
                if (!res.ok) throw new Error('Model not found');
                const buf = await res.arrayBuffer();
                showLoading('Parsing geometry...');
                const doc = rhino.File3dm.fromByteArray(new Uint8Array(buf));
                const shadowEnabled = document.getElementById('toggle-shadows').checked;
                const group = processDocObjects(doc, rhino, shadowEnabled);
                doc.delete();
                if (group.children.length === 0) throw new Error('No renderable geometry found');
                group.rotation.x = -Math.PI / 2;
                scene.add(group);
                modelGroup = group;
                const box = new THREE.Box3().setFromObject(group);
                box.getCenter(modelCenter); box.getSize(modelSize);
                modelSpan = Math.max(modelSize.x, modelSize.y, modelSize.z) || 10;
                const yOffset = -box.min.y;
                group.position.y += yOffset; modelCenter.y += yOffset;
                groundMeshes = [];
                group.traverse(c => { if (c.isMesh) groundMeshes.push(c); });
                is2DModel = groundMeshes.length === 0;
                const d = modelSpan;
                orbitCamera.position.set(modelCenter.x + d * 1.3, modelCenter.y + d * 1.1, modelCenter.z + d * 1.3);
                orbitCamera.lookAt(modelCenter);
                orbitCamera.near = d * 0.001; orbitCamera.far = d * 100;
                orbitCamera.updateProjectionMatrix();
                orbitControls.target.copy(modelCenter); orbitControls.update();
                walkCamera.near = flyCamera.near = orbitCamera.near;
                walkCamera.far = flyCamera.far = orbitCamera.far;
                walkCamera.updateProjectionMatrix();
                flyCamera.position.copy(orbitCamera.position); flyCamera.lookAt(modelCenter);
                syncOrthoCamera();
                setCameraMode(is2DModel ? 'ortho' : 'orbit');
                applyStyle(visualStyle);
                updateSun();
                hideLoading();
            } catch(e) { console.error(e); showLoading('Error: ' + e.message); }
        });
    }

    // ── Init ─────────────────────────────────────────────────────────────────
    function init() {
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x050608);
        renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
        document.body.appendChild(renderer.domElement);
        const aspect = window.innerWidth / window.innerHeight;
        orbitCamera = new THREE.PerspectiveCamera(50, aspect, 0.1, 1000000);
        orbitControls = new THREE.OrbitControls(orbitCamera, renderer.domElement);
        orbitControls.enableDamping = true; orbitControls.dampingFactor = 0.08;
        walkCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000000);
        walkCamera.rotation.order = 'YXZ';
        flyCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000000);
        flyCamera.rotation.order = 'YXZ';
        orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000000);
        activeCamera = orbitCamera;
        hemi = new THREE.HemisphereLight(0xd6e4f0, 0x3a3020, 0.65); scene.add(hemi);
        sun = new THREE.DirectionalLight(0xfff5e0, 1.2); sun.castShadow = true;
        sun.shadow.mapSize.width = sun.shadow.mapSize.height = 2048;
        scene.add(sun); scene.add(sun.target);
        fill = new THREE.DirectionalLight(0x8899cc, 0.3); fill.position.set(-5, 2, -5); scene.add(fill);

        window.addEventListener('resize', () => {
            const w = window.innerWidth, h = window.innerHeight;
            renderer.setSize(w, h);
            const a = w / h;
            orbitCamera.aspect = walkCamera.aspect = flyCamera.aspect = a;
            orbitCamera.updateProjectionMatrix(); walkCamera.updateProjectionMatrix(); flyCamera.updateProjectionMatrix();
            syncOrthoCamera();
        });
        window.addEventListener('keydown', e => {
            keys[e.code] = true;
            if (e.code === 'Digit1') setCameraMode('orbit');
            if (e.code === 'Digit2') setCameraMode('walk');
            if (e.code === 'Digit3') setCameraMode('fly');
            if (e.code === 'Digit4') setCameraMode('ortho');
            if (e.code === 'KeyR') resetCamera();
        });
        window.addEventListener('keyup', e => { keys[e.code] = false; });
        window.addEventListener('mousemove', e => {
            if (cameraMode !== 'walk' && cameraMode !== 'fly') return;
            if (document.pointerLockElement !== renderer.domElement) return;
            yaw -= e.movementX * 0.002; pitch -= e.movementY * 0.002;
            pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, pitch));
            if (cameraMode === 'walk') walkCamera.rotation.set(pitch, yaw, 0, 'YXZ');
            else flyCamera.rotation.set(pitch, yaw, 0, 'YXZ');
        });
        renderer.domElement.addEventListener('click', () => {
            if (cameraMode === 'walk' || cameraMode === 'fly') renderer.domElement.requestPointerLock();
        });
        document.getElementById('sun-az').addEventListener('input', updateSun);
        document.getElementById('sun-el').addEventListener('input', updateSun);
        document.getElementById('toggle-shadows').addEventListener('change', e => toggleShadows(e.target.checked));
        document.getElementById('bg-select').addEventListener('change', e => changeBackground(e.target.value));
        document.getElementById('ortho-toggle').addEventListener('click', toggleOrtho);
        
        document.querySelectorAll('.cam-btn[data-mode]').forEach(btn => btn.addEventListener('click', () => setCameraMode(btn.dataset.mode)));
        document.querySelectorAll('.style-btn').forEach(btn => btn.addEventListener('click', () => applyStyle(btn.dataset.style)));
        
        loadModel();
        (function anim() {
            requestAnimationFrame(anim);
            const spd = modelSpan * 0.004, radius = 0.5;
            if (cameraMode === 'walk') {
                const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)), move = new THREE.Vector3();
                if (keys['KeyW']) move.add(forward); if (keys['KeyS']) move.addScaledVector(forward, -1);
                if (keys['KeyA']) move.addScaledVector(right, -1); if (keys['KeyD']) move.add(right);
                if (move.lengthSq() > 0) velocity.addScaledVector(move.normalize(), spd);
                velocity.multiplyScalar(damping);
                const nextPos = walkCamera.position.clone().add(velocity);
                nextPos.y = getGroundY(nextPos.x, nextPos.z) + WALK_HEIGHT;
                if (!checkCollision(nextPos, radius)) walkCamera.position.copy(nextPos); else velocity.set(0,0,0);
            } else if (cameraMode === 'fly') {
                const f = new THREE.Vector3(), r = new THREE.Vector3(); flyCamera.getWorldDirection(f);
                r.crossVectors(f, flyCamera.up).normalize(); const move = new THREE.Vector3();
                if (keys['KeyW']) move.add(f); if (keys['KeyS']) move.addScaledVector(f, -1);
                if (keys['KeyA']) move.addScaledVector(r, -1); if (keys['KeyD']) move.add(r);
                if (keys['Space']) move.y += 1; if (keys['ShiftLeft']) move.y -= 1;
                if (move.lengthSq() > 0) velocity.addScaledVector(move.normalize(), spd);
                velocity.multiplyScalar(damping);
                const nextPos = flyCamera.position.clone().add(velocity);
                if (!checkCollision(nextPos, radius)) flyCamera.position.copy(nextPos); else velocity.set(0,0,0);
            } else if (cameraMode === 'orbit') orbitControls.update();
            renderer.render(scene, activeCamera);
        })();
    }
    init();
})();
