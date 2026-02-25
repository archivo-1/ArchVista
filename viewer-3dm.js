(function() {
    'use strict';

    // ── Core scene objects ──────────────────────────────────────────────────
    let scene, renderer, orbitCamera, walkCamera, flyCamera, orthoCamera, activeCamera, orbitControls;
    let cameraMode = 'orbit'; // 'orbit' | 'walk' | 'fly' | 'ortho'
    let is2DModel = false;
    let modelGroup = null;
    let groundMeshes = [];
    let modelCenter = new THREE.Vector3();
    let modelSize   = new THREE.Vector3();
    let modelSpan   = 10;
    const raycaster = new THREE.Raycaster();
    const downVec   = new THREE.Vector3(0, -1, 0);
    const keys      = {};
    const velocity  = new THREE.Vector3();
    const damping   = 0.85;
    let yaw = 0, pitch = 0;
    const WALK_HEIGHT = 1.7;

    // ── Visual style ────────────────────────────────────────────────────────
    // 'rendered' | 'clay' | 'wireframe' | 'xray'
    let visualStyle = 'rendered';
    // Cache of per-mesh material sets built at load time
    // meshMatCache[uuid] = { rendered, clay, wireframe, xray, line }
    const meshMatCache = {};

    // Special layer-name keywords → material overrides
    const LAYER_OVERRIDES = {
        glass:   { color: 0xadd8f7, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.35 },
        window:  { color: 0xadd8f7, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.35 },
        water:   { color: 0x1a6fa8, roughness: 0.1,  metalness: 0.3, transparent: true, opacity: 0.75 },
        ocean:   { color: 0x1a6fa8, roughness: 0.1,  metalness: 0.3, transparent: true, opacity: 0.75 },
        terrain: { color: 0x8a7560, roughness: 0.9,  metalness: 0.0 },
        ground:  { color: 0x8a7560, roughness: 0.9,  metalness: 0.0 },
        metal:   { color: 0x888888, roughness: 0.3,  metalness: 0.85 },
        steel:   { color: 0x888888, roughness: 0.3,  metalness: 0.85 },
        concrete:{ color: 0xb0a898, roughness: 0.85, metalness: 0.0 }
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

    // ── Camera mode UI ───────────────────────────────────────────────────────
    function updateModeUI() {
        const labels = { orbit: '1 · Orbit', walk: '2 · Walk', fly: '3 · Fly', ortho: '4 · Top View' };
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
        orthoCamera.top = halfH;   orthoCamera.bottom = -halfH;
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
    function resetCamera() {
        if (!modelGroup) return;
        if (cameraMode === 'orbit') {
            const d = modelSpan;
            orbitCamera.position.set(modelCenter.x + d * 1.4, modelCenter.y + d * 1.2, modelCenter.z + d * 1.4);
            orbitControls.target.copy(modelCenter);
            orbitControls.update();
        } else if (cameraMode === 'ortho') { syncOrthoCamera(); }
    }

    // ── Material helpers ─────────────────────────────────────────────────────
    // Build a full material set for a mesh given its Rhino color and layer name
    function buildMatSet(hexColor, layerName) {
        const lname = (layerName || '').toLowerCase();
        // Check for layer-name overrides
        let ovr = null;
        Object.keys(LAYER_OVERRIDES).forEach(function(k) {
            if (!ovr && lname.indexOf(k) !== -1) ovr = LAYER_OVERRIDES[k];
        });

        // Rendered material: uses Rhino color (or override)
        const rendParams = ovr ? Object.assign({ side: THREE.DoubleSide }, ovr)
            : { color: hexColor, roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide };
        const rendered = new THREE.MeshStandardMaterial(rendParams);

        // Clay: always neutral grey
        const clay = new THREE.MeshStandardMaterial({
            color: 0xdddddd, roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide
        });

        // Wireframe: same color but wireframe mode
        const wireframe = new THREE.MeshStandardMaterial({
            color: hexColor, wireframe: true, side: THREE.DoubleSide
        });

        // X-Ray: transparent with slight tint
        const xray = new THREE.MeshStandardMaterial({
            color: hexColor, transparent: true, opacity: 0.18,
            roughness: 0.3, metalness: 0.0,
            side: THREE.DoubleSide, depthWrite: false
        });

        return { rendered, clay, wireframe, xray };
    }

    function makeLineMat(hexColor) {
        return new THREE.LineBasicMaterial({ color: hexColor || 0x88aaff });
    }

    // Apply current visual style to all cached meshes
    function applyStyle(style) {
        visualStyle = style;
        // Update style button UI
        document.querySelectorAll('.style-btn').forEach(function(b) {
            b.classList.toggle('active', b.dataset.style === style);
        });
        // Swap materials
        if (!modelGroup) return;
        modelGroup.traverse(function(obj) {
            if (!obj.isMesh) return;
            const cache = meshMatCache[obj.uuid];
            if (!cache) return;
            obj.material = cache[style] || cache.rendered;
        });
    }

    // ── Rhino color utilities ────────────────────────────────────────────────
    // Convert Rhino color (object {r,g,b} or [r,g,b] or number) to THREE hex
    function rhinoColorToHex(rc) {
        if (!rc) return 0xcccccc;
        if (typeof rc === 'number') return rc;
        const r = rc.r !== undefined ? rc.r : (rc[0] || 0);
        const g = rc.g !== undefined ? rc.g : (rc[1] || 0);
        const b = rc.b !== undefined ? rc.b : (rc[2] || 0);
        return (r << 16) | (g << 8) | b;
    }

    // Returns { hexColor, layerName } for a given Rhino object + layer table
    function getObjAppearance(obj, layerTable) {
        let hexColor = 0xcccccc;
        let layerName = '';
        try {
            const attrs = obj.attributes();
            if (!attrs) return { hexColor, layerName };

            // Try object color first (only if color source is 'object')
            // colorSource: 0=ByLayer, 1=ByObject, 2=ByMaterial, 3=ByParent
            const colorSrc = attrs.colorSource;
            if (colorSrc === 1 || colorSrc === 'object') {
                hexColor = rhinoColorToHex(attrs.objectColor || attrs.drawColor);
            } else {
                // Fall back to layer color
                const layerIdx = attrs.layerIndex;
                if (layerTable && layerIdx !== undefined && layerIdx >= 0) {
                    try {
                        const layer = layerTable.get(layerIdx);
                        if (layer) {
                            layerName = layer.name || '';
                            hexColor = rhinoColorToHex(layer.color);
                        }
                    } catch(e) {}
                }
            }
        } catch(e) {}
        return { hexColor, layerName };
    }

    // ── Geometry conversion ─────────────────────────────────────────────────────
    // Tries every known strategy; now accepts appearance for coloring
    function rhinoGeomToThreeObjs(geom, rhino, appearance) {
        const results = [];
        const hex   = appearance ? appearance.hexColor : 0xcccccc;
        const lname = appearance ? appearance.layerName : '';

        // Strategy 1: toThreejsJSON (native mesh)
        if (typeof geom.toThreejsJSON === 'function') {
            try {
                const json   = geom.toThreejsJSON();
                const parsed = (typeof json === 'string') ? JSON.parse(json) : json;
                if (parsed && parsed.data && parsed.data.attributes) {
                    const geo = new THREE.BufferGeometryLoader().parse(parsed);
                    if (geo) {
                        const matSet = buildMatSet(hex, lname);
                        const mesh   = new THREE.Mesh(geo, matSet[visualStyle] || matSet.rendered);
                        meshMatCache[mesh.uuid] = matSet;
                        results.push(mesh);
                        return results;
                    }
                }
            } catch(e) { console.warn('toThreejsJSON failed:', e.message); }
        }

        // Strategy 2: getMesh (Brep / Extrusion / Surface)
        if (typeof geom.getMesh === 'function') {
            const meshTypes = [];
            try { meshTypes.push(rhino.MeshType.Any); }     catch(e) {}
            try { meshTypes.push(rhino.MeshType.Default); } catch(e) {}
            try { meshTypes.push(rhino.MeshType.Render); }  catch(e) {}
            meshTypes.push(0, 1, 2, 3, 4);
            for (let mi = 0; mi < meshTypes.length; mi++) {
                try {
                    const rm = geom.getMesh(meshTypes[mi]);
                    if (rm && typeof rm.toThreejsJSON === 'function') {
                        const json   = rm.toThreejsJSON();
                        const parsed = (typeof json === 'string') ? JSON.parse(json) : json;
                        if (parsed && parsed.data && parsed.data.attributes) {
                            const geo = new THREE.BufferGeometryLoader().parse(parsed);
                            if (geo) {
                                const matSet = buildMatSet(hex, lname);
                                const mesh   = new THREE.Mesh(geo, matSet[visualStyle] || matSet.rendered);
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

        // Strategy 3: curve sampling
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

        // Strategy 4: single point
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

    // ── Model loading ───────────────────────────────────────────────────────────
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

                // Extract layer table for color lookup
                let layerTable = null;
                try { layerTable = doc.layers(); } catch(e) {}

                const group = new THREE.Group();
                // Fix orientation: Rhino Z-up → THREE Y-up
                group.rotation.x = -Math.PI / 2;

                const objs  = doc.objects();
                const total = objs.count;
                console.log('Object count:', total);

                for (let i = 0; i < total; i++) {
                    try {
                        const obj = objs.get(i);
                        if (!obj) continue;
                        const geom = obj.geometry();
                        if (!geom) continue;
                        const appearance = getObjAppearance(obj, layerTable);
                        const threeObjs = rhinoGeomToThreeObjs(geom, rhino, appearance);
                        threeObjs.forEach(function(o) { group.add(o); });
                    } catch(e2) { console.warn('Skipping object ' + i + ':', e2.message); }
                }
                doc.delete();

                console.log('Group children:', group.children.length, '/', total);
                if (group.children.length === 0)
                    throw new Error('No renderable geometry found (' + total + ' objects parsed)');

                // Detect 2D model (no meshes, only lines)
                let hasMesh = false;
                group.children.forEach(function(c) { if (c.isMesh) hasMesh = true; });
                is2DModel = !hasMesh;

                // Collect ground meshes for walk-mode collision
                groundMeshes = [];
                group.traverse(function(c) { if (c.isMesh) groundMeshes.push(c); });

                scene.add(group);
                modelGroup = group;

                // Bounding box
                const box = new THREE.Box3().setFromObject(group);
                box.getCenter(modelCenter);
                box.getSize(modelSize);
                modelSpan = Math.max(modelSize.x, modelSize.y, modelSize.z) || 10;

                // Set up cameras
                const d = modelSpan;
                orbitCamera.position.set(modelCenter.x + d * 1.4, modelCenter.y + d * 1.2, modelCenter.z + d * 1.4);
                orbitCamera.lookAt(modelCenter);
                orbitCamera.near = d * 0.001; orbitCamera.far = d * 300;
                orbitCamera.updateProjectionMatrix();
                orbitControls.target.copy(modelCenter);
                orbitControls.update();

                walkCamera.near = flyCamera.near = orbitCamera.near;
                walkCamera.far  = flyCamera.far  = orbitCamera.far;
                walkCamera.updateProjectionMatrix();
                flyCamera.position.copy(orbitCamera.position);
                flyCamera.lookAt(modelCenter);
                flyCamera.updateProjectionMatrix();
                yaw = flyCamera.rotation.y; pitch = flyCamera.rotation.x;
                syncOrthoCamera();

                setCameraMode(is2DModel ? 'ortho' : 'orbit');
                // Apply default style
                applyStyle(visualStyle);
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
        document.body.appendChild(renderer.domElement);

        const aspect = window.innerWidth / window.innerHeight;
        orbitCamera  = new THREE.PerspectiveCamera(50, aspect, 0.1, 1000000);
        orbitControls = new THREE.OrbitControls(orbitCamera, renderer.domElement);
        orbitControls.enableDamping = true;
        orbitControls.dampingFactor = 0.08;
        orbitControls.maxPolarAngle = Math.PI * 0.88;
        orbitControls.minDistance   = 0.5;

        walkCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000000);
        walkCamera.rotation.order = 'YXZ';
        flyCamera  = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000000);
        flyCamera.rotation.order  = 'YXZ';
        orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000000);
        activeCamera = orbitCamera;

        // Lighting
        scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const sun = new THREE.DirectionalLight(0xffffff, 0.9);
        sun.position.set(1, 2, 1.5); scene.add(sun);
        const fill = new THREE.DirectionalLight(0x8899cc, 0.3);
        fill.position.set(-2, -0.5, -1); scene.add(fill);

        // Resize
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

        // Keyboard
        window.addEventListener('keydown', function(e) {
            keys[e.code] = true;
            if (e.code === 'Digit1') setCameraMode('orbit');
            if (e.code === 'Digit2') setCameraMode('walk');
            if (e.code === 'Digit3') setCameraMode('fly');
            if (e.code === 'Digit4') setCameraMode('ortho');
            if (e.code === 'KeyR')   resetCamera();
            if (e.code === 'Space' && (cameraMode === 'walk' || cameraMode === 'fly')) e.preventDefault();
        });
        window.addEventListener('keyup', function(e) { keys[e.code] = false; });

        // Mouse-look
        window.addEventListener('mousemove', function(e) {
            if (cameraMode !== 'walk' && cameraMode !== 'fly') return;
            if (document.pointerLockElement !== renderer.domElement) return;
            yaw   -= e.movementX * 0.002;
            pitch -= e.movementY * 0.002;
            pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
            if (cameraMode === 'walk') walkCamera.rotation.set(pitch, yaw, 0, 'YXZ');
            else                       flyCamera.rotation.set(pitch, yaw, 0, 'YXZ');
        });
        renderer.domElement.addEventListener('click', function() {
            if (cameraMode === 'walk' || cameraMode === 'fly') renderer.domElement.requestPointerLock();
        });

        // Ortho pan + zoom
        let orthoDrag = false, orthoLast = { x: 0, y: 0 };
        renderer.domElement.addEventListener('mousedown', function(e) {
            if (cameraMode === 'ortho') { orthoDrag = true; orthoLast = { x: e.clientX, y: e.clientY }; }
        });
        window.addEventListener('mouseup', function() { orthoDrag = false; });
        window.addEventListener('mousemove', function(e) {
            if (!orthoDrag || cameraMode !== 'ortho') return;
            const dx = (e.clientX - orthoLast.x) / window.innerWidth  * (orthoCamera.right - orthoCamera.left);
            const dz = (e.clientY - orthoLast.y) / window.innerHeight * (orthoCamera.top   - orthoCamera.bottom);
            orthoCamera.position.x -= dx;
            orthoCamera.position.z += dz;
            orthoLast = { x: e.clientX, y: e.clientY };
        });
        renderer.domElement.addEventListener('wheel', function(e) {
            if (cameraMode !== 'ortho') return;
            const f = e.deltaY > 0 ? 1.1 : 0.9;
            orthoCamera.left *= f; orthoCamera.right *= f;
            orthoCamera.top  *= f; orthoCamera.bottom *= f;
            orthoCamera.updateProjectionMatrix();
        }, { passive: true });

        // Camera + style buttons
        document.querySelectorAll('.cam-btn').forEach(function(btn) {
            btn.addEventListener('click', function() { setCameraMode(btn.dataset.mode); });
        });
        document.querySelectorAll('.style-btn').forEach(function(btn) {
            btn.addEventListener('click', function() { applyStyle(btn.dataset.style); });
        });

        loadModel();

        // Animation loop
        (function anim() {
            requestAnimationFrame(anim);
            const spd = modelSpan * 0.003;
            if (cameraMode === 'walk') {
                const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
                const right   = new THREE.Vector3( Math.cos(yaw), 0, -Math.sin(yaw));
                if (keys['KeyW']) velocity.addScaledVector(forward,  spd);
                if (keys['KeyS']) velocity.addScaledVector(forward, -spd);
                if (keys['KeyA']) velocity.addScaledVector(right,   -spd);
                if (keys['KeyD']) velocity.addScaledVector(right,    spd);
                velocity.multiplyScalar(damping);
                walkCamera.position.add(velocity);
                walkCamera.position.y = getGroundY(walkCamera.position.x, walkCamera.position.z) + WALK_HEIGHT;
            } else if (cameraMode === 'fly') {
                const f = new THREE.Vector3(), r = new THREE.Vector3();
                flyCamera.getWorldDirection(f);
                r.crossVectors(f, flyCamera.up).normalize();
                if (keys['KeyW']) velocity.addScaledVector(f,  spd);
                if (keys['KeyS']) velocity.addScaledVector(f, -spd);
                if (keys['KeyA']) velocity.addScaledVector(r, -spd);
                if (keys['KeyD']) velocity.addScaledVector(r,  spd);
                if (keys['Space'])    velocity.y += spd;
                if (keys['ShiftLeft'] || keys['ShiftRight']) velocity.y -= spd;
                velocity.multiplyScalar(damping);
                flyCamera.position.add(velocity);
            } else if (cameraMode === 'orbit') {
                orbitControls.update();
            }
            renderer.render(scene, activeCamera);
        })();
    }

    init();
})();
