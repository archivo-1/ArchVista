(function() {
    'use strict';

    let scene, renderer, orbitCamera, freeCamera, activeCamera, orbitControls;
    let freeMode = false;
    const keys = {};
    const velocity = new THREE.Vector3();
    const damping = 0.9;
    let yaw = 0, pitch = 0;

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

    function setModeLabel(isFree) {
        const el = document.getElementById('mode-label');
        if (el) el.textContent = isFree ? 'Free-Fly' : 'Orbit';
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

                scene.add(group);

                const box = new THREE.Box3().setFromObject(group);
                const center = new THREE.Vector3();
                const size = new THREE.Vector3();
                box.getCenter(center);
                box.getSize(size);
                const d = Math.max(size.x, size.y, size.z) || 10;

                orbitCamera.position.set(center.x + d * 2, center.y + d * 1.5, center.z + d * 2);
                orbitCamera.lookAt(center);
                orbitCamera.near = d * 0.001;
                orbitCamera.far = d * 200;
                orbitCamera.updateProjectionMatrix();
                orbitControls.target.copy(center);
                orbitControls.update();

                freeCamera.position.copy(orbitCamera.position);
                freeCamera.lookAt(center);
                freeCamera.rotation.order = 'YXZ';
                yaw = freeCamera.rotation.y;
                pitch = freeCamera.rotation.x;
                freeCamera.near = orbitCamera.near;
                freeCamera.far = orbitCamera.far;
                freeCamera.updateProjectionMatrix();

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

        orbitCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000000);
        freeCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000000);
        freeCamera.rotation.order = 'YXZ';
        activeCamera = orbitCamera;

        orbitControls = new THREE.OrbitControls(orbitCamera, renderer.domElement);
        orbitControls.enableDamping = true;

        scene.add(new THREE.AmbientLight(0xffffff, 0.8));
        const sun = new THREE.DirectionalLight(0xffffff, 0.8);
        sun.position.set(1, 2, 3);
        scene.add(sun);
        const sun2 = new THREE.DirectionalLight(0x8899bb, 0.3);
        sun2.position.set(-2, -1, -1);
        scene.add(sun2);

        window.addEventListener('resize', function() {
            const w = window.innerWidth, h = window.innerHeight;
            renderer.setSize(w, h);
            orbitCamera.aspect = freeCamera.aspect = w / h;
            orbitCamera.updateProjectionMatrix();
            freeCamera.updateProjectionMatrix();
        });

        window.addEventListener('keydown', function(e) {
            keys[e.code] = true;
            if (e.code === 'KeyF') {
                freeMode = !freeMode;
                activeCamera = freeMode ? freeCamera : orbitCamera;
                setModeLabel(freeMode);
                if (!freeMode && document.pointerLockElement === renderer.domElement)
                    document.exitPointerLock();
                orbitControls.enabled = !freeMode;
            }
            if (e.code === 'Space') e.preventDefault();
        });

        window.addEventListener('keyup', function(e) {
            keys[e.code] = false;
        });

        window.addEventListener('mousemove', function(e) {
            if (!freeMode || document.pointerLockElement !== renderer.domElement) return;
            yaw -= e.movementX * 0.002;
            pitch -= e.movementY * 0.002;
            pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
            freeCamera.rotation.set(pitch, yaw, 0, 'YXZ');
        });

        renderer.domElement.addEventListener('click', function() {
            if (freeMode) renderer.domElement.requestPointerLock();
        });

        loadModel();

        (function anim() {
            requestAnimationFrame(anim);
            if (freeMode) {
                const f = new THREE.Vector3(), r = new THREE.Vector3();
                freeCamera.getWorldDirection(f);
                f.y = 0; f.normalize();
                r.crossVectors(new THREE.Vector3(0, 1, 0), f).normalize();
                const spd = 0.5;
                if (keys['KeyW']) velocity.addScaledVector(f, spd);
                if (keys['KeyS']) velocity.addScaledVector(f, -spd);
                if (keys['KeyA']) velocity.addScaledVector(r, spd);
                if (keys['KeyD']) velocity.addScaledVector(r, -spd);
                if (keys['Space']) velocity.y += spd;
                if (keys['ShiftLeft'] || keys['ShiftRight']) velocity.y -= spd;
                velocity.multiplyScalar(damping);
                freeCamera.position.add(velocity);
            } else {
                orbitControls.update();
            }
            renderer.render(scene, activeCamera);
        })();
    }

    init();
})();
