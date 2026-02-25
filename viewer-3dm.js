(function() {
    'use strict';

    let scene, renderer, orbitCamera, walkCamera, flyCamera, orthoCamera, activeCamera, orbitControls;
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
        if (is2DModel && mode !== 'ortho') return; // 2D files locked to ortho
        const prev = cameraMode;
        cameraMode = mode;
        if ((prev === 'walk' || prev === 'fly') && document.pointerLockElement) {
            document.exitPointerLock();
        }
        if (mode === 'orbit') {
            activeCamera = orbitCamera;
            orbitControls.enabled = true;
        } else if (mode === 'walk') {
            activeCamera = walkCamera;
            orbitControls.enabled = false;
            // Place walk camera at ground level above orbit target
            const target = orbitControls.target.clone();
            const groundY = getGroundY(target.x, target.z);
            walkCamera.position.set(target.x, groundY + WALK_HEIGHT, target.z + modelSpan * 0.1);
            walkCamera.rotation.set(0, 0, 0, 'YXZ');
            yaw = 0; pitch = 0;
        } else if (mode === 'fly') {
            activeCamera = flyCamera;
            orbitControls.enabled = false;
            flyCamera.position.copy(orbitCamera.position);
            flyCamera.lookAt(orbitControls.target);
            yaw = flyCamera.rotation.y;
            pitch = flyCamera.rotation.x;
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
        const halfH = modelSpan * 0.7;
        const halfW = halfH * aspect;
        orthoCamera.left = -halfW; orthoCamera.right = halfW;
        orthoCamera.top = halfH; orthoCamera.bottom = -halfH;
        orthoCamera.position.set(modelCenter.x, modelCenter.y + modelSpan * 5, modelCenter.z);
        orthoCamera.lookAt(modelCenter);
        orthoCamera.updateProjectionMatrix();
    }

    function getGroundY(x, z) {
        // Cast a ray downward to find ground surface
        if (groundMeshes.length === 0) return modelCenter.y;
        const origin = new THREE.Vector3(x, modelCenter.y + modelSpan * 2, z);
        raycaster.set(origin, downVec);
        const hits = raycaster.intersectObjects(groundMeshes, false);
        if (hits.length > 0) return hits[0].point.y;
        return modelCenter.y;
    }

    function makeMeshMat() {
        return new THREE.MeshStandardMaterial({
            color: 0xdddddd, roughness: 0.65, metalness: 0.05,
            side: THREE.DoubleSide
        });
    }

    function makeLineMat() {
        return new THREE.LineBasicMaterial({ color: 0x88aaff });
    }

    // Robust conversion: tries every known strategy on every object
    function rhinoGeomToThreeObjs(geom, rhino) {
        const results = [];

        // --- Strategy 1: toThreejsJSON (works for Mesh natively) ---
        if (typeof geom.toThreejsJSON === 'function') {
            try {
                const json = geom.toThreejsJSON();
                const parsed = (typeof json === 'string') ? JSON.parse(json) : json;
                if (parsed && parsed.data && parsed.data.attributes) {
                    const loader = new THREE.BufferGeometryLoader();
                    const geo = loader.parse(parsed);
                    if (geo) {
                        results.push(new THREE.Mesh(geo, makeMeshMat()));
                        return results;
                    }
                }
            } catch(e) {
                console.warn('toThreejsJSON failed:', e.message);
            }
        }

        // --- Strategy 2: getMesh with MeshType.Any (Brep, Extrusion, Surface) ---
        if (typeof geom.getMesh === 'function') {
            const meshTypes = [];
            try { meshTypes.push(rhino.MeshType.Any); } catch(e) {}
            try { meshTypes.push(rhino.MeshType.Default); } catch(e) {}
            try { meshTypes.push(rhino.MeshType.Render); } catch(e) {}
            // Also try numeric values used by rhino3dm
            meshTypes.push(0, 1, 2, 3, 4);
            for (let mi = 0; mi < meshTypes.length; mi++) {
                try {
                    const rm = geom.getMesh(meshTypes[mi]);
                    if (rm && typeof rm.toThreejsJSON === 'function') {
                        const json = rm.toThreejsJSON();
                        const parsed = (typeof json === 'string') ? JSON.parse(json) : json;
                        if (parsed && parsed.data && parsed.data.attributes) {
                            const loader = new THREE.BufferGeometryLoader();
                            const geo = loader.parse(parsed);
                            if (geo) {
                                results.push(new THREE.Mesh(geo, makeMeshMat()));
                                rm.delete();
                                return results;
                            }
                        }
                        try { rm.delete(); } catch(e) {}
                    }
                } catch(e) {}
            }
        }

        // --- Strategy 3: Curve sampling via domain + pointAt ---
        if (typeof geom.domain !== 'undefined' && typeof geom.pointAt === 'function') {
            try {
                const domain = geom.domain;
                const t0 = (domain && typeof domain.min !== 'undefined') ? domain.min : 0;
                const t1 = (domain && typeof domain.max !== 'undefined') ? domain.max : 1;
                if (t1 > t0) {
                    const pts = [];
                    const steps = 80;
                    for (let s = 0; s <= steps; s++) {
                        const t = t0 + (t1 - t0) * (s / steps);
                        try {
                            const pt = geom.pointAt(t);
                            if (pt && pt.length >= 3) pts.push(new THREE.Vector3(pt[0], pt[1], pt[2]));
                        } catch(e) {}
                    }
                    if (pts.length >= 2) {
                        const geo = new THREE.BufferGeometry().setFromPoints(pts);
                        results.push(new THREE.Line(geo, makeLineMat()));
                        return results;
                    }
                }
            } catch(e) {
                console.warn('Curve sampling failed:', e.message);
            }
        }

        // --- Strategy 4: PointCloud / single point ---
        if (typeof geom.location !== 'undefined') {
            try {
                const loc = geom.location;
                if (loc && loc.length >= 3) {
                    const geo = new THREE.BufferGeometry();
                    geo.setAttribute('position', new THREE.Float32BufferAttribute([loc[0], loc[1], loc[2]], 3));
                    const mat = new THREE.PointsMaterial({ color: 0xffaa00, size: 0.5 });
                    results.push(new THREE.Points(geo, mat));
                    return results;
                }
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
                if (!res.ok) throw new Error('HTTP ' + res.status + ': model not found');
                const buf = await res.arrayBuffer();
                showLoading('Parsing geometry...');
                const doc = rhino.File3dm.fromByteArray(new Uint8Array(buf));
                if (!doc) throw new Error('Could not parse Rhino document');

                const group = new THREE.Group();

                      // FIX ORIENTATION: Convert from Rhino's Z-up to THREE.js Y-up
                      group.rotation.x = -Math.PI / 2;
                const objs = doc.objects();
                const total = objs.count;
                console.log('Object count:', total);

                for (let i = 0; i < total; i++) {
                    try {
                        const obj = objs.get(i);
                        if (!obj) continue;
                        const geom = obj.geometry();
                        if (!geom) continue;
                        console.log('Object', i, 'objectType:', geom.objectType);
                        const threeObjs = rhinoGeomToThreeObjs(geom, rhino);
                        threeObjs.forEach(function(o) { group.add(o); });
                    } catch (e2) {
                        console.warn('Skipping object ' + i + ':', e2.message);
                    }
                }

                doc.delete();
                console.log('Group children:', group.children.length, '/', total);

                if (group.children.length === 0) {
                    throw new Error('No renderable geometry found in model (' + total + ' objects parsed)');
                }

// Detect 2D model: only has Line/Points children, no Mesh
                let hasMesh = false, hasLineOnly = true;
                group.children.forEach(function(c) {
                    if (c.isMesh) { hasMesh = true; hasLineOnly = false; }
                });
                is2DModel = !hasMesh;

                // Collect ground meshes for collision (all meshes)
                groundMeshes = [];
                group.traverse(function(c) { if (c.isMesh) groundMeshes.push(c); });

                scene.add(group);
                modelGroup = group;

                // Compute bounding box
                const box = new THREE.Box3().setFromObject(group);
                box.getCenter(modelCenter);
                box.getSize(modelSize);
                modelSpan = Math.max(modelSize.x, modelSize.y, modelSize.z) || 10;

                // --- Set up Orbit camera ---
                const d = modelSpan;
                orbitCamera.position.set(modelCenter.x + d * 1.4, modelCenter.y + d * 1.2, modelCenter.z + d * 1.4);
                orbitCamera.lookAt(modelCenter);
                orbitCamera.near = d * 0.001;
                orbitCamera.far = d * 300;
                orbitCamera.updateProjectionMatrix();
                orbitControls.target.copy(modelCenter);
                orbitControls.update();

                // --- Set up Walk camera ---
                walkCamera.near = orbitCamera.near;
                walkCamera.far = orbitCamera.far;
                walkCamera.updateProjectionMatrix();

                // --- Set up Fly camera ---
                flyCamera.position.copy(orbitCamera.position);
                flyCamera.lookAt(modelCenter);
                flyCamera.near = orbitCamera.near;
                flyCamera.far = orbitCamera.far;
                flyCamera.updateProjectionMatrix();
                yaw = flyCamera.rotation.y;
                pitch = flyCamera.rotation.x;

                // --- Set up Ortho camera ---
                syncOrthoCamera();

                // Auto-select mode
                if (is2DModel) {
                    setCameraMode('ortho');
                } else {
                    setCameraMode('orbit');
                }

                hideLoading();
            } catch (e) {
                console.error(e);
                showLoading('Error: ' + e.message);
            }
        });
    }

    function init() {
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x050608);
        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        document.body.appendChild(renderer.domElement);

        const aspect = window.innerWidth / window.innerHeight;

        // Orbit camera (perspective)
        orbitCamera = new THREE.PerspectiveCamera(50, aspect, 0.1, 1000000);
        orbitControls = new THREE.OrbitControls(orbitCamera, renderer.domElement);
        orbitControls.enableDamping = true;
        orbitControls.dampingFactor = 0.08;
        orbitControls.maxPolarAngle = Math.PI * 0.88; // Prevent going underground
        orbitControls.minDistance = 0.5;

        // Walk camera (1st person)
        walkCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000000);
        walkCamera.rotation.order = 'YXZ';

        // Fly camera (free)
        flyCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000000);
        flyCamera.rotation.order = 'YXZ';

        // Ortho camera (top-down)
        orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000000);

        activeCamera = orbitCamera;

        // Lighting
        scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const sun = new THREE.DirectionalLight(0xffffff, 0.9);
        sun.position.set(1, 2, 1.5);
        scene.add(sun);
        const fill = new THREE.DirectionalLight(0x8899cc, 0.3);
        fill.position.set(-2, -0.5, -1);
        scene.add(fill);

        // Resize handler
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

        // Keyboard input
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

        // Mouse-look (pointer lock)
        window.addEventListener('mousemove', function(e) {
            if (cameraMode !== 'walk' && cameraMode !== 'fly') return;
            if (document.pointerLockElement !== renderer.domElement) return;
            yaw -= e.movementX * 0.002;
            pitch -= e.movementY * 0.002;
            pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
            if (cameraMode === 'walk') { walkCamera.rotation.set(pitch, yaw, 0, 'YXZ'); }
            else { flyCamera.rotation.set(pitch, yaw, 0, 'YXZ'); }
        });

        renderer.domElement.addEventListener('click', function() {
            if (cameraMode === 'walk' || cameraMode === 'fly') renderer.domElement.requestPointerLock();
        });

        // Ortho panning with mouse drag
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
            const factor = e.deltaY > 0 ? 1.1 : 0.9;
            orthoCamera.left *= factor; orthoCamera.right *= factor;
            orthoCamera.top *= factor; orthoCamera.bottom *= factor;
            orthoCamera.updateProjectionMatrix();
        }, { passive: true });

        // Camera buttons
        document.querySelectorAll('.cam-btn').forEach(function(btn) {
            btn.addEventListener('click', function() { setCameraMode(btn.dataset.mode); });
        });

        loadModel();

        // Animation loop
        (function anim() {
            requestAnimationFrame(anim);
            const spd = modelSpan * 0.003;

            if (cameraMode === 'walk') {
                // Horizontal movement only
                const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
                const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
                if (keys['KeyW']) velocity.addScaledVector(forward, spd);
                if (keys['KeyS']) velocity.addScaledVector(forward, -spd);
                if (keys['KeyA']) velocity.addScaledVector(right, -spd);
                if (keys['KeyD']) velocity.addScaledVector(right, spd);
                velocity.multiplyScalar(damping);
                walkCamera.position.add(velocity);
                // Ground collision: snap to terrain + WALK_HEIGHT
                const gY = getGroundY(walkCamera.position.x, walkCamera.position.z);
                walkCamera.position.y = gY + WALK_HEIGHT;

            } else if (cameraMode === 'fly') {
                const f = new THREE.Vector3(), r = new THREE.Vector3();
                flyCamera.getWorldDirection(f);
                r.crossVectors(f, flyCamera.up).normalize();
                if (keys['KeyW']) velocity.addScaledVector(f, spd);
                if (keys['KeyS']) velocity.addScaledVector(f, -spd);
                if (keys['KeyA']) velocity.addScaledVector(r, -spd);
                if (keys['KeyD']) velocity.addScaledVector(r, spd);
                if (keys['Space']) velocity.y += spd;
                if (keys['ShiftLeft'] || keys['ShiftRight']) velocity.y -= spd;
                velocity.multiplyScalar(damping);
                flyCamera.position.add(velocity);

            } else if (cameraMode === 'orbit') {
                orbitControls.update();
            }

            renderer.render(scene, activeCamera);
        })();
    }

    function resetCamera() {
        if (!modelGroup) return;
        if (cameraMode === 'orbit') {
            const d = modelSpan;
            orbitCamera.position.set(modelCenter.x + d * 1.4, modelCenter.y + d * 1.2, modelCenter.z + d * 1.4);
            orbitControls.target.copy(modelCenter);
            orbitControls.update();
        } else if (cameraMode === 'ortho') {
            syncOrthoCamera();
        }
    }

    init();
})();
