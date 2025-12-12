import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

// --- Game Constants ---
const LANE_WIDTH = 5;       
const LANES = [-LANE_WIDTH, 0, LANE_WIDTH]; 
const PLAYER_RUN_HEIGHT = 1.5; 
const JUMP_HEIGHT = 4.5;
const JUMP_DURATION = 0.5; 
const SLIDE_HEIGHT = 0.5; 
const COLLISION_SLIDE_HEIGHT = 1; 
const RUN_SPEED_BASE = 15; 
const RUN_SPEED_INCREASE = 0.5; 
const OBSTACLE_SPAWN_Z = -200; 
const OBSTACLE_CULL_Z = 10;    

// Progression Timing (15 units/sec * 30 seconds = 450 score distance)
const PHASE_DURATION_SCORE = 450; 

// --- Game State Variables ---
let scene, camera, renderer, composer;
let clock = new THREE.Clock();
let gameLoopId;
let isPaused = false;
let isGameOver = false;
let currentLane = 1; 
let isJumping = false;
let jumpStartTime = 0;
let isSliding = false;
let slideStartTime = 0;
let isPunching = false;
let punchStartTime = 0;
let score = 0;
let currentSpeed = RUN_SPEED_BASE;
let obstacles = [];
let debrisParticles = []; 
let floatingParticles; 

// For Time-Based Obstacle Generation
let timeSinceLastObstacle = 0; 

// --- Collision Box ---
const playerCollisionBox = new THREE.Box3();
const playerCollisionSize = new THREE.Vector3(LANE_WIDTH * 0.8, PLAYER_RUN_HEIGHT, 1);

// --- Asset/Model Loading Setup ---
const loadingManager = new THREE.LoadingManager();
const loadingBar = document.getElementById('loading-bar');
const loadingOverlay = document.getElementById('loading-overlay');

loadingManager.onProgress = (url, itemsLoaded, itemsTotal) => {
    const progress = (itemsLoaded / itemsTotal) * 100;
    loadingBar.style.width = progress + '%';
};
loadingManager.onLoad = () => {
    console.log('Assets loaded!');
    loadingOverlay.classList.add('hidden');
    document.getElementById('game-over-screen').classList.add('hidden');
    initGame();
};

// --- Audio Placeholders ---
const sfx = {
    // Using silent data URLs as placeholders (real SFX would be loaded here)
    running: new Audio('data:audio/wav;base64,UklGRl9vT1JXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAAAABAAEAwBgAABgCABgQAADaAgAASmZhY3QcAAAAAAAAGwEAAJmEAAAAZGF0YaD7/8P//w=='),
    jump: new Audio('data:audio/wav;base64,UklGRl9vT1JXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAAAABAAEAwBgAABgCABgQAADaAgAASmZhY3QcAAAAAAAAGwEAAJmEAAAAZGF0YaD7/8P//w=='),
    slide: new Audio('data:audio/wav;base64,UklGRl9vT1JXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAAAABAAEAwBgAABgCABgQAADaAgAASmZhY3QcAAAAAAAAGwEAAJmEAAAAZGF0YaD7/8P//w=='),
    punch: new Audio('data:audio/wav;base64,UklGRl9vT1JXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAAAABAAEAwBgAABgCABgQAADaAgAASmZhY3QcAAAAAAAAGwEAAJmEAAAAZGF0YaD7/8P//w=='),
    collision: new Audio('data:audio/wav;base64,UklGRl9vT1JXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAAAABAAEAwBgAABgCABgQAADaAgAASmZhY3QcAAAAAAAAGwEAAJmEAAAAZGF0YaD7/8P//w=='),
    shatter: new Audio('data:audio/wav;base64,UklGRl9vT1JXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAAAABAAEAwBgAABgCABgQAADaAgAASmZhY3QcAAAAAAAAGwEAAJmEAAAAZGF0YaD7/8P//w==')
};
sfx.running.loop = true;
sfx.running.volume = 0.1;

// --- Progression Management (TIME-BASED PHASES) ---

const PROGRESSION_STAGES = [
    // Phase 1: Pure Run / Warmup (Start at Score 0)
    { distance: 0, type: 'warmup', interval: 40 }, // High interval = rarely/never spawn
    
    // Phase 2: JUMP obstacles only (Starts after ~30 seconds)
    { distance: PHASE_DURATION_SCORE * 1, type: 'jump_only', interval: 30 }, 
    
    // Phase 3: SLIDE obstacles only (Starts after ~60 seconds)
    { distance: PHASE_DURATION_SCORE * 2, type: 'slide_only', interval: 30 }, 
    
    // Phase 4: LANE DODGE (Left/Right Walls) only (Starts after ~90 seconds)
    { distance: PHASE_DURATION_SCORE * 3, type: 'dodge_only', interval: 25 }, 
    
    // Phase 5: PUNCH WALL obstacles only (Starts after ~120 seconds)
    { distance: PHASE_DURATION_SCORE * 4, type: 'punch_only', interval: 30 },
    
    // Phase 6: Full Combination (ALL obstacles)
    { distance: PHASE_DURATION_SCORE * 5, type: 'full_combo', interval: 20 } 
];

class ProgressionManager {
    constructor() {
        this.currentStageIndex = 0;
        this.currentStage = PROGRESSION_STAGES[0];
    }

    update(score) {
        if (this.currentStageIndex < PROGRESSION_STAGES.length - 1 && 
            score >= PROGRESSION_STAGES[this.currentStageIndex + 1].distance) {
            
            this.currentStageIndex++;
            this.currentStage = PROGRESSION_STAGES[this.currentStageIndex];
            console.log(`Advanced to Stage: ${this.currentStage.type} at Score ${Math.floor(score)}`);
        }
    }

    getStage() {
        return this.currentStage;
    }
}

let progressionManager = new ProgressionManager();


// --- Initialization Functions ---
function initThreeJS() {
    scene = new THREE.Scene();
    // Snowy Sky Color: Light Blue/Grey
    scene.fog = new THREE.Fog(0x445566, 10, 150); 

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(LANES[currentLane], PLAYER_RUN_HEIGHT, 0);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    document.body.appendChild(renderer.domElement);
    
    // Post-processing (Bloom for Christmas Lights/Glow)
    const renderPass = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
    bloomPass.threshold = 0.2;
    bloomPass.strength = 1.5; 
    bloomPass.radius = 0.5;
    
    composer = new EffectComposer(renderer);
    composer.addPass(renderPass);
    composer.addPass(bloomPass);

    window.addEventListener('resize', onWindowResize);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
}

function loadModels() {
    // Since we are not providing a GLTF file, the fallback will always run immediately
    const dracoLoader = new DRACOLoader(loadingManager);
    dracoLoader.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/');
    
    const gltfLoader = new GLTFLoader(loadingManager);
    gltfLoader.setDRACOLoader(dracoLoader);
    
    gltfLoader.load(
        'scene.gltf',
        (gltf) => {
            console.log('GLTF loaded successfully (using fallback geometry)');
            createEnvironment(); 
        },
        (xhr) => {
             // Fake progress for loading bar
             loadingManager.onProgress('scene.gltf', xhr.loaded, xhr.total * 2); 
        },
        (error) => {
            console.error('GLTF Load failed/not found. Using simple geometry for Christmas Scene.', error);
            createEnvironment();
            // Manually trigger load completion since model failed
            loadingManager.onLoad(); 
        }
    );
}

// --- Environment & Assets (Snowy Theme) ---
function createEnvironment() {
    const ROAD_LENGTH = 100;
    const ROAD_WIDTH = LANE_WIDTH * 3 + 2;
    
    // Road Material: Light Icy Blue/Grey (Snowy Road)
    const roadMaterial = new THREE.MeshLambertMaterial({ 
        color: 0x99aacc,
    });
    
    // Shoulder Material: White Snow Banks
    const shoulderMaterial = new THREE.MeshLambertMaterial({ 
        color: 0xeeeeee, 
    });

    // Create 3 road chunks for seamless looping
    for (let i = 0; i < 3; i++) {
        const chunk = new THREE.Group();
        chunk.position.z = -i * ROAD_LENGTH;
        
        // Main Road Surface
        const roadGeo = new THREE.PlaneGeometry(ROAD_WIDTH, ROAD_LENGTH);
        const roadMesh = new THREE.Mesh(roadGeo, roadMaterial);
        roadMesh.rotation.x = -Math.PI / 2;
        roadMesh.position.y = 0.01;
        chunk.add(roadMesh);
        
        // Lane Markers (Glowing Icy White/Blue)
        for (let l = 0; l < LANES.length - 1; l++) {
            const markerGeo = new THREE.PlaneGeometry(0.2, 5);
            const markerMat = new THREE.MeshBasicMaterial({ 
                color: 0xaaffff, emissive: 0xaaffff, emissiveIntensity: 5 
            });
            const markerMesh = new THREE.Mesh(markerGeo, markerMat);
            markerMesh.rotation.x = -Math.PI / 2;
            markerMesh.position.set(LANES[l] + LANE_WIDTH / 2, 0.02, 0);
            chunk.add(markerMesh);
        }

        // Shoulders (Snow Banks)
        const shoulderGeo = new THREE.PlaneGeometry(10, ROAD_LENGTH);
        const shoulderMeshL = new THREE.Mesh(shoulderGeo, shoulderMaterial);
        const shoulderMeshR = new THREE.Mesh(shoulderGeo, shoulderMaterial);
        shoulderMeshL.rotation.x = shoulderMeshR.rotation.x = -Math.PI / 2;
        shoulderMeshL.position.set(-ROAD_WIDTH / 2 - 5, 0, 0);
        shoulderMeshR.position.set(ROAD_WIDTH / 2 + 5, 0, 0);
        chunk.add(shoulderMeshL);
        chunk.add(shoulderMeshR);
        
        scene.add(chunk);
    }

    scene.children.filter(c => c instanceof THREE.Group).forEach(c => {
        c.userData.type = 'RoadChunk';
    });

    // Add Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.2));
    scene.add(new THREE.PointLight(0xffffff, 100).position.set(0, 10, 0));

    createFloatingParticles();
}

// Floating Snow/Star Particles
function createFloatingParticles() {
    const particleCount = 500;
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const colors = [];
    const color = new THREE.Color();

    for (let i = 0; i < particleCount; i++) {
        positions.push(
            (Math.random() - 0.5) * 100,
            Math.random() * 20 + 5,      
            (Math.random() - 0.5) * 200 - 100
        );
        
        // Snowy/Festive colors
        if (Math.random() < 0.6) {
            color.setHex(0xffffff); // White Snow
        } else if (Math.random() < 0.8) {
            color.setHex(0x00aaff); // Icy Blue
        } else {
            color.setHex(0xffdd00); // Gold Star
        }
        colors.push(color.r, color.g, color.b);
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size: 0.5,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        sizeAttenuation: true,
        depthWrite: false
    });

    floatingParticles = new THREE.Points(geometry, material);
    scene.add(floatingParticles);
}

// --- Game Logic ---

function initGame() {
    // sfx.running.play();
    clock.start();
    startGameLoop();
}

function resetGame() {
    isGameOver = false;
    isPaused = false;
    currentLane = 1;
    score = 0;
    currentSpeed = RUN_SPEED_BASE;
    
    // Reset Progression
    progressionManager = new ProgressionManager(); 
    timeSinceLastObstacle = 0;
    
    camera.position.set(LANES[currentLane], PLAYER_RUN_HEIGHT, 0);
    
    obstacles.forEach(o => scene.remove(o));
    obstacles = [];
    
    debrisParticles.forEach(p => scene.remove(p));
    debrisParticles = [];

    document.getElementById('game-over-screen').classList.add('hidden');
    document.getElementById('score-counter').innerText = 'SCORE: 0';
    
    // sfx.running.play();
    clock.start();
    startGameLoop();
}

function startGameLoop() {
    if (gameLoopId) cancelAnimationFrame(gameLoopId);
    animate();
}

function gameOver() {
    isGameOver = true;
    cancelAnimationFrame(gameLoopId);
    // sfx.running.pause();

    document.getElementById('final-score').innerText = `Final Score: ${Math.floor(score)}`;
    document.getElementById('game-over-screen').classList.remove('hidden');
}

// --- Obstacle Management ---

function createObstacle(lane, type) {
    let geometry, material, height, isBreakable = false;
    
    // Christmas Themed Obstacles
    switch (type) {
        case 'jump': // Candy Cane Jump Bar (low bar to jump over)
            geometry = new THREE.BoxGeometry(LANE_WIDTH * 0.8, 1, 1);
            material = new THREE.MeshBasicMaterial({ 
                color: 0xff0000, emissive: 0xff0000, emissiveIntensity: 2 
            });
            height = 0.5;
            break;
        case 'slide': // Hanging Wreath/Tinsel Garland (high object to slide under)
            geometry = new THREE.BoxGeometry(LANE_WIDTH * 0.8, 1, 1);
            material = new THREE.MeshBasicMaterial({ 
                color: 0x008800, emissive: 0x008800, emissiveIntensity: 2 
            });
            height = PLAYER_RUN_HEIGHT + 0.5;
            break;
        case 'wall': // Snow Pile / Gift Boxes (blocks lane, forces dodge L/R)
            geometry = new THREE.BoxGeometry(LANE_WIDTH * 0.8, 1.5, 1);
            material = new THREE.MeshBasicMaterial({ 
                color: 0xddddff, emissive: 0xddddff, emissiveIntensity: 1
            });
            height = 0.75;
            break;
        case 'breakable': // Ice Wall / Gingerbread Wall (must be punched)
            geometry = new THREE.BoxGeometry(LANE_WIDTH * 0.8, 2.5, 1);
            material = new THREE.MeshBasicMaterial({ 
                color: 0x88cccc, emissive: 0x88cccc, emissiveIntensity: 2.5 
            });
            height = 1.25;
            isBreakable = true;
            break;
    }
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(LANES[lane], height, OBSTACLE_SPAWN_Z);
    
    mesh.userData = { 
        type: 'Obstacle', 
        obstacleType: type,
        isBreakable: isBreakable,
        collided: false 
    }; 
    
    obstacles.push(mesh);
    scene.add(mesh);
}

function getObstacleTypeForStage(stageType) {
    const allTypes = ['jump', 'slide', 'wall', 'breakable'];
    switch (stageType) {
        case 'warmup':
            return null;
        case 'jump_only':
            return ['jump'];
        case 'slide_only':
            return ['slide'];
        case 'dodge_only':
            return ['wall']; 
        case 'punch_only':
            return ['breakable'];
        case 'full_combo':
            // Randomly select one type from all four core actions for combined challenge
            return [allTypes[Math.floor(Math.random() * allTypes.length)]];
        default:
            return null;
    }
}

function generateObstacles(delta) {
    const currentStage = progressionManager.getStage();
    
    const allowedTypes = getObstacleTypeForStage(currentStage.type);
    if (!allowedTypes) return; 

    // Calculate time to wait based on stage interval and current speed
    const spawnIntervalTime = currentStage.interval / currentSpeed; 
    
    timeSinceLastObstacle += delta;

    if (timeSinceLastObstacle < spawnIntervalTime) return;
    
    timeSinceLastObstacle = 0; // Reset timer

    // --- Obstacle Spawning Logic ---
    let blockedLanes = [];
    
    // Determine how many lanes to block (1 or 2, depending on complexity)
    let numObstacles = (currentStage.type === 'full_combo' || currentStage.type === 'dodge_only') ? 
        (Math.random() < 0.6 ? 1 : 2) : 1;

    // Select the specific lanes to block
    const laneOptions = [0, 1, 2];
    
    if (numObstacles === 2) {
        // Block 2 lanes, leave 1 open
        const laneToKeepOpen = laneOptions[Math.floor(Math.random() * 3)];
        blockedLanes = laneOptions.filter(l => l !== laneToKeepOpen);
    } else {
        // Block a single random lane
        blockedLanes = [laneOptions[Math.floor(Math.random() * 3)]];
    }
    
    // Select the obstacle type for this spawn group
    const typeToSpawn = allowedTypes[Math.floor(Math.random() * allowedTypes.length)]; 

    blockedLanes.forEach(lane => {
        createObstacle(lane, typeToSpawn);
    });
}


// --- Player Actions ---
function jump() {
    if (isJumping || isSliding || isGameOver) return;
    isJumping = true;
    jumpStartTime = clock.getElapsedTime();
    sfx.jump.currentTime = 0; sfx.jump.play();
}

function slide() {
    if (isJumping || isSliding || isGameOver) return;
    isSliding = true;
    slideStartTime = clock.getElapsedTime();
    sfx.slide.currentTime = 0; sfx.slide.play();
    setTimeout(() => { isSliding = false; }, 1000); 
}

function punch() {
    if (isPunching || isGameOver) return;
    isPunching = true;
    punchStartTime = clock.getElapsedTime();
    sfx.punch.currentTime = 0; sfx.punch.play();
    setTimeout(() => { isPunching = false; }, 300);
}

function moveLane(direction) {
    if (isJumping || isGameOver) return; 
    currentLane = Math.max(0, Math.min(2, currentLane + direction));
}

// --- Collision and Breakable Wall Logic ---
function checkCollisions() {
    let playerY = isSliding ? SLIDE_HEIGHT : PLAYER_RUN_HEIGHT;
    let playerH = isSliding ? COLLISION_SLIDE_HEIGHT : PLAYER_RUN_HEIGHT;

    playerCollisionBox.setFromCenterAndSize(
        new THREE.Vector3(camera.position.x, playerY, camera.position.z),
        new THREE.Vector3(playerCollisionSize.x, playerH, playerCollisionSize.z)
    );

    obstacles.forEach(obstacle => {
        if (obstacle.userData.collided) return;
        
        const obstacleBox = new THREE.Box3().setFromObject(obstacle);
        
        if (playerCollisionBox.intersectsBox(obstacleBox)) {
            
            if (obstacle.userData.isBreakable && isPunching) {
                shatterWall(obstacle);
                sfx.shatter.currentTime = 0; sfx.shatter.play();
            } else if (obstacle.userData.obstacleType === 'jump' && isJumping && camera.position.y > obstacle.position.y + 0.5) {
                return; 
            } else if (obstacle.userData.obstacleType === 'slide' && isSliding && camera.position.y < obstacle.position.y - 0.5) {
                return; 
            } else {
                sfx.collision.currentTime = 0; sfx.collision.play();
                gameOver();
            }
            obstacle.userData.collided = true;
        }
    });
}

function shatterWall(wall) {
    scene.remove(wall);
    wall.userData.collided = true;

    // Camera Shake Effect
    const initialY = camera.position.y;
    camera.position.y += 0.5;
    setTimeout(() => { camera.position.y = initialY; }, 100);

    // Particle Explosion
    const particleCount = 50;
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const velocities = [];

    for (let i = 0; i < particleCount; i++) {
        positions.push(wall.position.x, wall.position.y, wall.position.z);
        
        velocities.push(
            (Math.random() - 0.5) * 5, 
            Math.random() * 5 + 2,     
            (Math.random() - 0.5) * 5  
        );
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('velocity', new THREE.Float32BufferAttribute(velocities, 3));
    
    const material = new THREE.PointsMaterial({
        color: wall.material.color.getHex(),
        size: 0.2,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false
    });

    const particles = new THREE.Points(geometry, material);
    particles.userData.ttl = 1.0; 
    debrisParticles.push(particles);
    scene.add(particles);
}

function updateDebris(delta) {
    for (let i = debrisParticles.length - 1; i >= 0; i--) {
        const particles = debrisParticles[i];
        particles.userData.ttl -= delta;

        if (particles.userData.ttl <= 0) {
            scene.remove(particles);
            debrisParticles.splice(i, 1);
            continue;
        }

        const positions = particles.geometry.attributes.position.array;
        const velocities = particles.geometry.attributes.velocity.array;
        
        particles.material.opacity = particles.userData.ttl;

        for (let j = 0; j < positions.length / 3; j++) {
            positions[j * 3 + 0] += velocities[j * 3 + 0] * delta;
            positions[j * 3 + 1] += velocities[j * 3 + 1] * delta - 9.8 * delta * delta;
            positions[j * 3 + 2] += velocities[j * 3 + 2] * delta;
        }
        
        particles.geometry.attributes.position.needsUpdate = true;
    }
}

// --- Animation Loop ---
function animate() {
    gameLoopId = requestAnimationFrame(animate);

    if (isPaused || isGameOver) return;

    const delta = clock.getDelta();
    const elapsed = clock.getElapsedTime();
    
    // 1. Update Game Speed
    currentSpeed = RUN_SPEED_BASE + Math.floor(elapsed / 10) * RUN_SPEED_INCREASE;
    
    // 2. Update Player Actions (Jump/Slide)
    if (isJumping) {
        const timeInJump = elapsed - jumpStartTime;
        const progress = timeInJump / JUMP_DURATION;
        
        if (progress < 1) {
            const jumpY = JUMP_HEIGHT * 4 * (progress - progress * progress);
            camera.position.y = PLAYER_RUN_HEIGHT + jumpY;
        } else {
            isJumping = false;
            camera.position.y = PLAYER_RUN_HEIGHT;
        }
    }

    if (isSliding) {
        camera.position.y = SLIDE_HEIGHT;
    } else if (!isJumping) {
        camera.position.y = PLAYER_RUN_HEIGHT;
    }
    
    const targetX = LANES[currentLane];
    camera.position.x += (targetX - camera.position.x) * 0.1;

    // 3. World Movement & Recycling
    const distance = currentSpeed * delta;
    
    scene.children.filter(c => c.userData.type === 'RoadChunk').forEach(chunk => {
        chunk.position.z += distance;
        if (chunk.position.z >= 0) {
            let maxZ = 0;
            scene.children.filter(c => c.userData.type === 'RoadChunk').forEach(other => {
                maxZ = Math.min(maxZ, other.position.z);
            });
            chunk.position.z = maxZ - 100;
        }
    });

    obstacles.forEach(obstacle => {
        obstacle.position.z += distance;
    });

    for (let i = obstacles.length - 1; i >= 0; i--) {
        if (obstacles[i].position.z > OBSTACLE_CULL_Z) {
            scene.remove(obstacles[i]);
            obstacles.splice(i, 1);
        }
    }
    
    debrisParticles.forEach(p => {
        p.position.z += distance;
    });

    updateDebris(delta);
    
    if (floatingParticles) {
        const positions = floatingParticles.geometry.attributes.position.array;
        for (let i = 2; i < positions.length; i += 3) {
            positions[i] += distance * 0.5;
            if (positions[i] > 10) positions[i] = -200; 
        }
        floatingParticles.geometry.attributes.position.needsUpdate = true;
        floatingParticles.rotation.y += 0.0005;
    }

    // 4. Collision Check
    checkCollisions();

    // 5. Progression and Obstacle Generation
    progressionManager.update(score);
    generateObstacles(delta);

    // 6. Score Update
    score += distance * 0.1; 
    document.getElementById('score-counter').innerText = `SCORE: ${Math.floor(score)}`;

    // 7. Render
    composer.render();
}

// --- Event Handlers (Keyboard + Touch) ---
document.addEventListener('keydown', (e) => {
    if (isGameOver || isPaused) return;
    switch (e.key) {
        case 'ArrowLeft': case 'a': moveLane(-1); break;
        case 'ArrowRight': case 'd': moveLane(1); break;
        case 'ArrowUp': case 'w': case ' ': jump(); break;
        case 'ArrowDown': case 's': slide(); break;
        case 'p': case 'Enter': punch(); break;
    }
});

document.getElementById('jump-button').addEventListener('click', jump);
document.getElementById('slide-button').addEventListener('click', slide);
document.getElementById('left-button').addEventListener('click', () => moveLane(-1));
document.getElementById('right-button').addEventListener('click', () => moveLane(1));
document.getElementById('punch-button').addEventListener('click', punch);
document.getElementById('restart-button').addEventListener('click', resetGame);
document.getElementById('pause-button').addEventListener('click', () => {
    // Pause Logic here
    isPaused = !isPaused;
    const icon = document.getElementById('pause-button').querySelector('i');
    const gameOverScreen = document.getElementById('game-over-screen');
    const restartButton = document.getElementById('restart-button');

    if (isPaused) {
        icon.classList.remove('fa-pause');
        icon.classList.add('fa-play');
        gameOverScreen.classList.remove('hidden');
        gameOverScreen.classList.add('bg-opacity-50');
        gameOverScreen.querySelector('h1').innerText = 'PAUSED';
        document.getElementById('final-score').innerText = 'Press RESUME or ESC';
        restartButton.innerText = 'RESUME';
        
        restartButton.onclick = () => {
            isPaused = false;
            gameOverScreen.classList.add('hidden');
            restartButton.onclick = resetGame; 
            icon.classList.remove('fa-play');
            icon.classList.add('fa-pause');
        };
        
    } else {
        icon.classList.remove('fa-play');
        icon.classList.add('fa-pause');
        gameOverScreen.classList.add('hidden');
        restartButton.onclick = resetGame; 
    }
});

document.addEventListener('keyup', (e) => {
     if (e.key === 'Escape') {
        document.getElementById('pause-button').click();
    }
});

// --- Kickoff ---
initThreeJS();
loadModels();
