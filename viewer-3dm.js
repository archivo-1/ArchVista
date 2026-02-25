(function() {
    'use strict';

    let scene, renderer, orbitCamera, freeCamera, activeCamera, orbitControls;
    let freeMode = false;
    const keys = {};
    const velocity = new THREE.Vector3();
    const moveSpeed = 15;
    const damping = 0.88;
    let lastTime = performance.now();
    let yaw = 0, pitch = 0;

    function getModelFromQuery() {
        const params = new URLSearchParams(window.location.search);
        return params.get('model') || 'torpederas-valparaisoCLS.3dm';
    }

    function showLoading() {
        const el = document.getElementById('loading');
        if (el) el.classList.remove('hidden');
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
        let layerName = '';
        if (obj.userData && obj.userData.attributes) {
            const attr = obj.userData.attributes;
            if (typeof attr.layer === 'string') layerName = attr.layer.toLowerCase();
        }
        if (!layerName && typeof obj.userData.layer === 'string') {
            layerName = obj.userData.layer.toLowerCase();
        }
        
        const name = (obj.name || '').toLowerCase();
        const keywords = ['glass', 'window', 'vidrio', 'cristal'];
        for (let k of keywords) {
            if (layerName.indexOf(k) !== -1 || name.indexOf(k) !== -1) return true;
        }
        return false;
    }

    function rhinoMeshToBuffer(rhinoMesh) {
        const geo = new THREE.BufferGeometry();
        const vertices = rhinoMesh.vertices();
        const vertexCount = vertices.count;
        const posArray = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertexCount; i++) {
            const pt = vertices.get(i);
            posArray[i * 3] = pt[0];
            posArray[i * 3 + 1] = pt[1];
            posArray[i * 3 + 2] = pt[2];
        }
        geo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));

        const faces = rhinoMesh.faces();
        const faceCount = faces.count;
        const indices = [];
        for (let j = 0; j < faceCount; j++) {
            const face = faces.get(j);
            indices.push(face[0], face[1], face[2]);
            if (face[2] !== face[3]) {
                indices.push(face[0], face[2], face[3]);
            }
        }
        geo.setIndex(indices);

        const normals = rhinoMesh.normals();
        if (normals && normals.count === vertexCount) {
            const normArray = new Float32Array(vertexCount * 3);
            for (let k = 0; k < vertexCount; k++) {
                const nv = normals.get(k);
                normArray[k * 3] = nv[0];
                normArray[k * 3 + 1] = nv[1];
                normArray[k * 3 + 2] = nv[2];
            }
            geo.setAttribute('normal', new THREE.BufferAttribute(normArray, 3));
        } else {
            geo.computeVertexNormals();
        }
        return geo;
    }

    function makeMat(isGl) {
        if (isGl) {
            return new THREE.MeshStandardMaterial({
                color: 0x88b4e8,
                roughness: 0.05,
                metalness: 0,
                transparent: true,
                opacity: 0.32,
                side: THREE.DoubleSide
            });
        }
        return new THREE.MeshStandardMaterial({
            color: 0xf0f0f0,
            roughness: 0.55,
            metalness: 0.05,
            side: THREE.DoubleSide
        });
    }

    function loadModel() {
        const file = 'models/' + getModelFromQuery();
        showLoading();

        rhino3dm().then(async rhino => {
            try {
                const response = await fetch(file);
                if (!response.ok) throw new Error('Model not found');
                const buffer = await response.arrayBuffer();
                const doc = rhino.File3dm.fromByteArray(new Uint8Array(buffer));
                if (!doc) throw new Error('Failed to parse 3DM');

                const group = new THREE.Group();
                const objects = doc.objects();
                
                for (let i = 0; i < objects.count; i++) {
                    const obj = objects.get(i);
                    const geometry = obj.geometry();
                    const gl = isGlass(obj);
                    
                    if (geometry.objectType === rhino.ObjectType.Mesh) {
                        const bufferGeo = rhinoMeshToBuffer(geometry);
                        const mesh = new THREE.Mesh(bufferGeo, makeMat(gl));
                        mesh.castShadow = true;
                        mesh.receiveShadow = true;
                        group.add(mesh);
                    } else if (geometry.objectType === rhino.ObjectType.Extrusion || geometry.objectType === rhino.ObjectType.Brep) {
                        const rhinoMesh = geometry.getMesh(rhino.MeshType.Any);
                        if (rhinoMesh) {
                            const bufferGeo = rhinoMeshToBuffer(rhinoMesh);
                            const mesh = new THREE.Mesh(bufferGeo, makeMat(gl));
                            mesh.castShadow = true;
                            mesh.receiveShadow = true;
                            group.add(mesh);
                            rhinoMesh.delete();
                        }
                    }
                }

                scene.add(group);
                
                const box = new THREE.Box3().setFromObject(group);
                const center = new THREE.Vector3();
                const size = new THREE.Vector3();
                box.getCenter(center);
                box.getSize(size);
                
                const maxDim = Math.max(size.x, size.y, size.z) || 10;
                const dist = maxDim * 2.5;
                
                orbitCamera.position.set(center.x + dist, center.y + dist * 0.6, center.z + dist);
                orbitCamera.lookAt(center);
                orbitControls.target.copy(center);
                orbitControls.update();
                
                freeCamera.position.set(center.x + maxDim * 0.6, center.y + maxDim * 0.4, center.z + maxDim * 0.9);
                freeCamera.lookAt(center);
                freeCamera.rotation.order = 'YXZ';
                yaw = freeCamera.rotation.y;
                pitch = freeCamera.rotation.x;
                
                doc.delete();
                hideLoading();
            } catch (err) {
                console.error(err);
                hideLoading();
            }
        });
    }

    function onResize() {
        const w = window.innerWidth, h = window.innerHeight;
        orbitCamera.aspect = freeCamera.aspect = w / h;
        orbitCamera.updateProjectionMatrix();
        freeCamera.updateProjectionMatrix();
        renderer.setSize(w, h);
    }

    function onKeyDown(e) {
        keys[e.code] = true;
        if (e.code === 'KeyF') {
            freeMode = !freeMode;
            activeCamera = freeMode ? freeCamera : orbitCamera;
            setModeLabel(freeMode);
            if (!freeMode && document.pointerLockElement === renderer.domElement) {
                document.exitPointerLock();
            }
            orbitControls.enabled = !freeMode;
        }
        if (e.code === 'Space') e.preventDefault();
    }

    function onKeyUp(e) {
        keys[e.code] = false;
    }

    function onMouseMove(e) {
        if (!freeMode || document.pointerLockElement !== renderer.domElement) return;
        
        yaw -= e.movementX * 0.0022;
        pitch -= e.movementY * 0.0022;
        
        const limit = Math.PI / 2 - 0.01;
        if (pitch > limit) pitch = limit;
        if (pitch < -limit) pitch = -limit;
        
        freeCamera.rotation.set(pitch, yaw, 0, 'YXZ');
    }

    function updateFly(dt) {
        velocity.multiplyScalar(damping);
        const forward = new THREE.Vector3();
        const right = new THREE.Vector3();
        
        freeCamera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        
        right.crossVectors(THREE.Object3D.DEFAULT_UP, forward).normalize();
        
        const s = moveSpeed * dt;
        if (keys['KeyW']) velocity.add(forward.multiplyScalar(s));
        if (keys['KeyS']) velocity.add(forward.multiplyScalar(-s));
        if (keys['KeyA']) velocity.add(right.multiplyScalar(s));
        if (keys['KeyD']) velocity.add(right.multiplyScalar(-s));
        if (keys['KeySpace']) velocity.y += s;
        if (keys['ShiftLeft'] || keys['ShiftRight']) velocity.y -= s;
        
        freeCamera.position.add(velocity);
    }

    function animate() {
        requestAnimationFrame(animate);
        const now = performance.now();
        const dt = (now - lastTime) / 1000;
        lastTime = now;

        if (freeMode) {
            updateFly(dt);
        } else {
            orbitControls.update();
        }
        renderer.render(scene, activeCamera);
    }

    function init() {
        const w = window.innerWidth, h = window.innerHeight;
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x050608);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(w, h);
        renderer.shadowMap.enabled = true;
        renderer.domElement.tabIndex = 1;
        document.body.appendChild(renderer.domElement);

        orbitCamera = new THREE.PerspectiveCamera(60, w / h, 0.1, 20000);
        freeCamera = new THREE.PerspectiveCamera(75, w / h, 0.1, 20000);
        activeCamera = orbitCamera;

        orbitControls = new THREE.OrbitControls(orbitCamera, renderer.domElement);
        orbitControls.enableDamping = true;

        scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1a2e, 0.85));
        const sun = new THREE.DirectionalLight(0xfff4e0, 0.9);
        sun.position.set(100, 180, 80);
        sun.castShadow = true;
        scene.add(sun);

        window.addEventListener('resize', onResize);
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('mousemove', onMouseMove);

        renderer.domElement.addEventListener('click', () => {
            if (freeMode) {
                renderer.domElement.requestPointerLock();
                renderer.domElement.focus();
            }
        });

        loadModel();
        animate();
    }

    init();
})();
