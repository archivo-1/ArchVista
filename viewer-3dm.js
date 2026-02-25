(function() {
    'use strict';

    let scene, renderer, orbitCamera, freeCamera, activeCamera, orbitControls;
    let freeMode = false;
    const keys = {};
    const velocity = new THREE.Vector3();
    const moveSpeed = 20;
    const damping = 0.9;
    let lastTime = performance.now();
    let yaw = 0, pitch = 0;

    function getModelFromQuery() {
        const params = new URLSearchParams(window.location.search);
        return params.get('model') || 'torpederas-valparaisoCLS.3dm';
    }

    function showLoading(msg) {
        const el = document.getElementById('loading');
        if (el) {
            el.classList.remove('hidden');
            if (msg) el.querySelector('p').textContent = msg;
        }
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
        if (obj.userData && obj.userData.attributes && typeof obj.userData.attributes.layer === 'string') l = obj.userData.attributes.layer.toLowerCase();
        else if (obj.userData && typeof obj.userData.layer === 'string') l = obj.userData.layer.toLowerCase();
        const n = (obj.name || '').toLowerCase();
        return ['glass', 'window', 'vidrio', 'cristal'].some(k => l.includes(k) || n.includes(k));
    }

    function rhinoMeshToBuffer(rm) {
        const geo = new THREE.BufferGeometry();
        const v = rm.vertices();
        const c = v.count;
        const pos = new Float32Array(c * 3);
        for (let i = 0; i < c; i++) {
            const p = v.get(i);
            pos[i*3]=p[0]; pos[i*3+1]=p[1]; pos[i*3+2]=p[2];
        }
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const f = rm.faces();
        const fc = f.count;
        const idx = [];
        for (let j = 0; j < fc; j++) {
            const face = f.get(j);
            idx.push(face[0], face[1], face[2]);
            if (face[2] !== face[3]) idx.push(face[0], face[2], face[3]);
        }
        geo.setIndex(idx);
        const n = rm.normals();
        if (n && n.count === c) {
            const na = new Float32Array(c * 3);
            for (let k = 0; k < c; k++) {
                const nv = n.get(k);
                na[k*3]=nv[0]; na[k*3+1]=nv[1]; na[k*3+2]=nv[2];
            }
            geo.setAttribute('normal', new THREE.BufferAttribute(na, 3));
        } else geo.computeVertexNormals();
        return geo;
    }

    function loadModel() {
        const name = getModelFromQuery();
        showLoading('Downloading ' + name + '...');
        rhino3dm().then(async rhino => {
            try {
                const res = await fetch('models/' + name);
                if (!res.ok) throw new Error('Model 404');
                const buffer = await res.arrayBuffer();
                showLoading('Processing 3D Data...');
                const doc = rhino.File3dm.fromByteArray(new Uint8Array(buffer));
                const group = new THREE.Group();
                const objs = doc.objects();
                for (let i = 0; i < objs.count; i++) {
                    const obj = objs.get(i);
                    const geom = obj.geometry();
                    const gl = isGlass(obj);
                    const mat = new THREE.MeshStandardMaterial({
                        color: gl ? 0x88b4e8 : 0xeeeeee,
                        roughness: gl ? 0.1 : 0.6,
                        metalness: 0.1,
                        transparent: gl,
                        opacity: gl ? 0.3 : 1,
                        side: THREE.DoubleSide
                    });
                    if (geom.objectType === rhino.ObjectType.Mesh) {
                        group.add(new THREE.Mesh(rhinoMeshToBuffer(geom), mat));
                    } else if (geom.objectType === rhino.ObjectType.Extrusion || geom.objectType === rhino.ObjectType.Brep) {
                        const m = geom.getMesh(rhino.MeshType.Any);
                        if (m) {
                            group.add(new THREE.Mesh(rhinoMeshToBuffer(m), mat));
                            m.delete();
                        }
                    }
                }
                scene.add(group);
                const box = new THREE.Box3().setFromObject(group);
                const center = new THREE.Vector3();
                const size = new THREE.Vector3();
                box.getCenter(center);
                box.getSize(size);
                const d = Math.max(size.x, size.y, size.z) || 10;
                orbitCamera.position.set(center.x + d*2, center.y + d*1.5, center.z + d*2);
                orbitCamera.lookAt(center);
                orbitControls.target.copy(center);
                orbitControls.update();
                freeCamera.position.copy(orbitCamera.position);
                freeCamera.lookAt(center);
                yaw = freeCamera.rotation.y; pitch = freeCamera.rotation.x;
                doc.delete();
                hideLoading();
            } catch (e) {
                showLoading('Error: ' + e.message);
            }
        });
    }

    function init() {
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x111111);
        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        document.body.appendChild(renderer.domElement);
        
        orbitCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100000);
        freeCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100000);
        freeCamera.rotation.order = 'YXZ';
        activeCamera = orbitCamera;
        
        orbitControls = new THREE.OrbitControls(orbitCamera, renderer.domElement);
        orbitControls.enableDamping = true;
        
        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const l = new THREE.DirectionalLight(0xffffff, 0.8);
        l.position.set(1, 2, 3);
        scene.add(l);
        
        window.addEventListener('resize', () => {
            const w = window.innerWidth, h = window.innerHeight;
            renderer.setSize(w, h);
            orbitCamera.aspect = freeCamera.aspect = w / h;
            orbitCamera.updateProjectionMatrix(); freeCamera.updateProjectionMatrix();
        });
        window.addEventListener('keydown', e => {
            keys[e.code] = true;
            if (e.code === 'KeyF') {
                freeMode = !freeMode; activeCamera = freeMode ? freeCamera : orbitCamera;
                setModeLabel(freeMode); orbitControls.enabled = !freeMode;
            }
        });
        window.addEventListener('keyup', e => keys[e.code] = false);
        window.addEventListener('mousemove', e => {
            if (!freeMode || document.pointerLockElement !== renderer.domElement) return;
            yaw -= e.movementX * 0.002; pitch -= e.movementY * 0.002;
            pitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, pitch));
            freeCamera.rotation.set(pitch, yaw, 0, 'YXZ');
        });
        renderer.domElement.addEventListener('click', () => { if (freeMode) renderer.domElement.requestPointerLock(); });

        loadModel();
        (function anim() {
            requestAnimationFrame(anim);
            if (freeMode) {
                const f = new THREE.Vector3(), r = new THREE.Vector3();
                freeCamera.getWorldDirection(f); f.y = 0; f.normalize();
                r.crossVectors(new THREE.Vector3(0,1,0), f).normalize();
                if (keys['KeyW']) velocity.add(f.multiplyScalar(0.5));
                if (keys['KeyS']) velocity.add(f.multiplyScalar(-0.5));
                if (keys['KeyA']) velocity.add(r.multiplyScalar(0.5));
                if (keys['KeyD']) velocity.add(r.multiplyScalar(-0.5));
                velocity.multiplyScalar(damping);
                freeCamera.position.add(velocity);
            } else orbitControls.update();
            renderer.render(scene, activeCamera);
        })();
    }
    init();
})();
