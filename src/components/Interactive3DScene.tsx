import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export const Interactive3DScene = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const objectsRef = useRef<THREE.Object3D[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;

    // Scene setup
    const scene = new THREE.Scene();
    scene.background = null;
    sceneRef.current = scene;

    // Camera setup
    const camera = new THREE.PerspectiveCamera(
      75,
      containerRef.current.clientWidth / containerRef.current.clientHeight,
      0.1,
      1000
    );
    camera.position.z = 8;
    cameraRef.current = camera;

    // Renderer setup
    const renderer = new THREE.WebGLRenderer({ 
      antialias: true, 
      alpha: true 
    });
    renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const pointLight1 = new THREE.PointLight(0xffa500, 2, 100);
    pointLight1.position.set(5, 5, 5);
    scene.add(pointLight1);

    const pointLight2 = new THREE.PointLight(0xffeb3b, 1.5, 100);
    pointLight2.position.set(-5, -5, 5);
    scene.add(pointLight2);

    // Create floating dashboard screens
    const createScreen = (x: number, y: number, z: number, color: number) => {
      const geometry = new THREE.BoxGeometry(2, 1.5, 0.1);
      const material = new THREE.MeshPhongMaterial({ 
        color, 
        emissive: color,
        emissiveIntensity: 0.3,
        transparent: true,
        opacity: 0.9
      });
      const screen = new THREE.Mesh(geometry, material);
      screen.position.set(x, y, z);
      scene.add(screen);
      objectsRef.current.push(screen);
      return screen;
    };

    // Create holographic elements
    const createHologram = (x: number, y: number, z: number) => {
      const geometry = new THREE.TorusGeometry(0.5, 0.2, 16, 100);
      const material = new THREE.MeshPhongMaterial({ 
        color: 0xffa500,
        emissive: 0xffa500,
        emissiveIntensity: 0.5,
        transparent: true,
        opacity: 0.7,
        wireframe: true
      });
      const torus = new THREE.Mesh(geometry, material);
      torus.position.set(x, y, z);
      scene.add(torus);
      objectsRef.current.push(torus);
      return torus;
    };

    // Create 3D text-like shapes for platform features
    const createFeatureIcon = (x: number, y: number, z: number) => {
      const geometry = new THREE.OctahedronGeometry(0.4);
      const material = new THREE.MeshPhongMaterial({ 
        color: 0xffd700,
        emissive: 0xffd700,
        emissiveIntensity: 0.4,
        transparent: true,
        opacity: 0.85
      });
      const icon = new THREE.Mesh(geometry, material);
      icon.position.set(x, y, z);
      scene.add(icon);
      objectsRef.current.push(icon);
      return icon;
    };

    // Create multiple screens and elements
    createScreen(-3, 2, 0, 0x4169e1); // Course dashboard
    createScreen(3, 2, -1, 0x32cd32); // Exam system
    createScreen(0, -2, -0.5, 0xff6347); // Attendance
    
    createHologram(-2, -1, 1);
    createHologram(2, 1, 1.5);
    
    createFeatureIcon(-1, 3, -1);
    createFeatureIcon(1, 3, -1);
    createFeatureIcon(0, 0, 2);

    // Particles for tech effect
    const particlesGeometry = new THREE.BufferGeometry();
    const particlesCount = 500;
    const positions = new Float32Array(particlesCount * 3);

    for (let i = 0; i < particlesCount * 3; i++) {
      positions[i] = (Math.random() - 0.5) * 20;
    }

    particlesGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const particlesMaterial = new THREE.PointsMaterial({
      color: 0xffa500,
      size: 0.05,
      transparent: true,
      opacity: 0.6
    });
    const particles = new THREE.Points(particlesGeometry, particlesMaterial);
    scene.add(particles);

    // Mouse interaction
    let mouseX = 0;
    let mouseY = 0;

    const handleMouseMove = (event: MouseEvent) => {
      mouseX = (event.clientX / window.innerWidth) * 2 - 1;
      mouseY = -(event.clientY / window.innerHeight) * 2 + 1;
    };

    window.addEventListener('mousemove', handleMouseMove);

    // Animation loop
    const animate = () => {
      requestAnimationFrame(animate);

      // Rotate objects
      objectsRef.current.forEach((obj, index) => {
        obj.rotation.x += 0.005 * (index % 2 === 0 ? 1 : -1);
        obj.rotation.y += 0.005;
        obj.position.y += Math.sin(Date.now() * 0.001 + index) * 0.002;
      });

      // Rotate particles
      particles.rotation.y += 0.0005;
      particles.rotation.x += 0.0002;

      // Camera follows mouse
      camera.position.x += (mouseX * 2 - camera.position.x) * 0.05;
      camera.position.y += (-mouseY * 2 - camera.position.y) * 0.05;
      camera.lookAt(scene.position);

      renderer.render(scene, camera);
    };

    animate();

    // Handle resize
    const handleResize = () => {
      if (!containerRef.current) return;
      const width = containerRef.current.clientWidth;
      const height = containerRef.current.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };

    window.addEventListener('resize', handleResize);

    // Cleanup
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('resize', handleResize);
      if (containerRef.current && renderer.domElement) {
        containerRef.current.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, []);

  return (
    <div 
      ref={containerRef} 
      className="w-full h-[600px] rounded-xl overflow-hidden"
      style={{ 
        background: 'linear-gradient(135deg, rgba(26, 83, 92, 0.1) 0%, rgba(255, 165, 0, 0.1) 100%)'
      }}
    />
  );
};
