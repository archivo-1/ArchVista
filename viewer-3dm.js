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

    function isGlass(obj) {
        let l = '';
        if (obj.userData && obj.userData.attributes && typeof obj.userData.attributes.layer === 'string')
            l = obj.userData.attributes.layer.toLowerCase();
        else if (obj.userData && typeof obj.userData.layer === 'string')
            l = obj.userData.layer.toLowerCase();
        const n = (obj.name || '').toLowerCase();
        return ['glass', 'window', 'vidrio', 'cristal'].some(k => l.includes(k) || n.includes(k));
    }

    // Use rhino3dm's built-in toThreejsJSON to convert a Mesh object
    function rhinoMeshToThreejs(rhinoMesh, mat) {
        const loader = new THREE.BufferGeometryLoader();
        const json = JSON.parse(rhinoMesh.toThreejsJSON());
        // toThreejsJSON returns a BufferGeometry JSON
        const geo = loader.parse(json);
        return new THREE.Mesh(geo, mat);
    }

    function makeMat(gl) {
        return new THREE.MeshStandardMaterial({
            color: gl ? 0x88b4e8 : 0xeeeeee,
            roughness: gl ? 0.1 : 0.6,
            metalness: 0.05,
            transparent: gl,
            opacity: gl ? 0.3 : 1.0,
            side: THREE.DoubleSide
        });
    }

    function loadModel() {
        const name = getModelFromQuery();
        showLoading('Downloading ' + name + '...');

        rhino3dm().then(async function(rhino) {
            try {
                showLoading('Fetching model...');
                const res = await fetch('models/' + name);
                if (!res.ok) throw new Error('HTTP ' + res.status + ': model not found');
                const buf = await res.arrayBuffer();

                showLoading('Parsing geometry...');
                const doc = rhino.File3dm.fromByteArray(new Uint8Array(buf));
                if (!doc) throw new Error('Could not parse Rhino document');

                const group = new THREE.Group();
                const objs = doc.objects();

                for (let i = 0; i < objs.count; i++) {
                    const obj = objs.get(i);
                    const geom = obj.geometry();
                    const gl = isGlass(obj);
                    const mat = makeMat(gl);

                    try {
                        if (geom.objectType === rhino.ObjectType.Mesh) {
                            const m = rhinoMeshToThreejs(geom, mat);
                            group.add(m);
                        } else if (geom.objectType === rhino.ObjectType.Extrusion ||
                                   geom.objectType === rhino.ObjectType.Brep) {
                            const rm = geom.getMesh(rhino.MeshType.Any);
                            if (rm) {
                                group.add(rhinoMeshToThreejs(rm, mat));
                                rm.delete();
                            }
                        }
                    } catch (e2) {
                        console.warn('Skipping object ' + i + ':', e2.message);
                    }
                }

                if (group.children.length === 0) {
                    throw new Error('No renderable geometry found in model');
                }

                scene.add(group);

                // Fit camera to model
                const box = new THREE.Box3().setFromObject(group);
                const center = new THREE.Vector3();
                const size = new THREE.Vector3();
                box.getCenter(center);
                box.getSize(size);
                const d = Math.max(size.x, size.y, size.z) || 10;

                orbitCamera.position.set(center.x + d * 2, center.y + d * 1.5, center.z + d * 2);
                orbitCamera.lookAt(center);
                orbitCamera.near = d * 0.001;
                orbitCamera.far = d * 100;
                orbitCamera.updateProjectionMatrix();

                orbitControls.target.copy(center);
                orbitControls.update();

                freeCamera.position.copy(orbitCamera.position);
                freeCamera.lookAt(center);
                freeCamera.rotation.order = 'YXZ';
                yaw = freeCamera.rotation.y;
                pitch = freeCamera.rotation.x;
                freeCamera.near = d * 0.001;
                freeCamera.far = d * 100;
                freeCamera.updateProjectionMatrix();

                doc.delete();
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

        scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const sun = new THREE.DirectionalLight(0xffffff, 0.8);
        sun.position.set(1, 2, 3);
        scene.add(sun);
        const sun2 = new THREE.DirectionalLight(0xffffff, 0.3);
        sun2.position.set(-1, -1, -2);
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
        window.addEventListener('keyup', function(e) { keys[e.code] = false; });
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
                freeCamera.getWorldDirection(f); f.y = 0; f.normalize();
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
