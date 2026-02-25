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

    // Port logic from Three.js 3DMLoader's worker decodeObjects function
    function convertRhinoObject(obj, rhino) {
        const geom = obj.geometry();
        const objType = geom.objectType;
        const typeName = objType && objType.constructor ? objType.constructor.name : 'Unknown';
        
        console.log('Object type:', typeName);

        const loader = new THREE.BufferGeometryLoader();
        let geometry = null;

        try {
            // Mesh or PointSet — direct toThreejsJSON
            if (typeName === 'ObjectType_Mesh' || typeName === 'ObjectType_PointSet') {
                geometry = loader.parse(JSON.parse(geom.toThreejsJSON()));
                const mesh = new THREE.Mesh(geometry, makeMeshMat());
                return [mesh];
            }

            // Brep — iterate faces and combine meshes
            if (typeName === 'ObjectType_Brep') {
                const faces = geom.faces();
                const combinedMesh = new rhino.Mesh();
                for (let i = 0; i < faces.count; i++) {
                    const face = faces.get(i);
                    const faceMesh = face.getMesh(rhino.MeshType.Any);
                    if (faceMesh) {
                        combinedMesh.append(faceMesh);
                        faceMesh.delete();
                    }
                    face.delete();
                }
                faces.delete();
                if (combinedMesh.faces().count > 0) {
                    combinedMesh.compact();
                    geometry = loader.parse(JSON.parse(combinedMesh.toThreejsJSON()));
                    combinedMesh.delete();
                    const mesh = new THREE.Mesh(geometry, makeMeshMat());
                    return [mesh];
                }
                combinedMesh.delete();
            }

            // Extrusion — getMesh
            if (typeName === 'ObjectType_Extrusion') {
                const extMesh = geom.getMesh(rhino.MeshType.Any);
                if (extMesh) {
                    geometry = loader.parse(JSON.parse(extMesh.toThreejsJSON()));
                    extMesh.delete();
                    const mesh = new THREE.Mesh(geometry, makeMeshMat());
                    return [mesh];
                }
            }

            // SubD — subdivide + createFromSubDControlNet
            if (typeName === 'ObjectType_SubD') {
                geom.subdivide(3);
                const subDMesh = rhino.Mesh.createFromSubDControlNet(geom);
                if (subDMesh) {
                    geometry = loader.parse(JSON.parse(subDMesh.toThreejsJSON()));
                    subDMesh.delete();
                    const mesh = new THREE.Mesh(geometry, makeMeshMat());
                    return [mesh];
                }
            }

            // Curve — sample points
            if (typeName === 'ObjectType_Curve') {
                const pts = [];
                const domain = geom.domain;
                if (domain) {
                    const steps = 80;
                    const t0 = domain[0], t1 = domain[1];
                    for (let s = 0; s <= steps; s++) {
                        const t = t0 + (t1 - t0) * (s / steps);
                        const pt = geom.pointAt(t);
                        if (pt) pts.push(new THREE.Vector3(pt[0], pt[1], pt[2]));
                    }
                }
                if (pts.length >= 2) {
                    const lineGeom = new THREE.BufferGeometry().setFromPoints(pts);
                    const line = new THREE.Line(lineGeom, makeLineMat());
                    return [line];
                }
            }

            // Point — single point
            if (typeName === 'ObjectType_Point') {
                const pt = geom.location;
                if (pt) {
                    const pointGeom = new THREE.BufferGeometry();
                    pointGeom.setAttribute('position', new THREE.Float32BufferAttribute(pt, 3));
                    const mat = new THREE.PointsMaterial({ color: 0xffaa00, size: 3, sizeAttenuation: false });
                    const points = new THREE.Points(pointGeom, mat);
                    return [points];
                }
            }

        } catch (e) {
            console.warn('Error converting', typeName, ':', e.message);
        }

        return [];
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
                const objs = doc.objects();
                const total = objs.count;
                console.log('Object count:', total);

                for (let i = 0; i < total; i++) {
                    try {
                        const obj = objs.get(i);
                        if (!obj) continue;
                        const threeObjs = convertRhinoObject(obj, rhino);
                        threeObjs.forEach(function(o) {
                            o.visible = true; // Override layer visibility
                            group.add(o);
                        });
                    } catch (e2) {
                        console.warn('Skipping object ' + i + ':', e2.message);
                    }
                }

                doc.delete();
                console.log('Rendered objects:', group.children.length, '/', total);

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
