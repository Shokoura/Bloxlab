// 3D viewport: WebGL renderer, Studio fly camera, picking, selection outlines, transform gizmos.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CFrame, Vector3 } from '../engine/datatypes.js';
import { cframeToMatrix } from '../render/scene.js';

const UP = new THREE.Vector3(0, 1, 0);

export class Viewport {
  constructor(app, container) {
    this.app = app;
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, app.settings.get('pixelRatioCap')));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = app.settings.get('shadows');
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'viewport-canvas';
    this.canvas.tabIndex = 0;
    container.append(this.canvas);
    this.overlay = document.createElement('div');
    this.overlay.className = 'viewport-overlay';
    container.append(this.overlay);

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 20000);
    this.camera.position.set(0, 20, 34);
    this.yaw = 0; this.pitch = -0.45;
    this.applyCameraAngles();
    this.view = null;
    this.mode = 'edit';
    this.keys = new Set();
    this.selectionHelpers = new Map();
    this.tool = 'select';
    this.size = { w: 1, h: 1 };

    this.gizmo = new TransformControls(this.camera, this.canvas);
    this.gizmo.setSize(0.9);
    this.gizmoProxy = new THREE.Object3D();
    this.gizmoHelper = this.gizmo.getHelper();
    this.gizmo.addEventListener('dragging-changed', (e) => this.onGizmoDragging(e.value));
    this.gizmo.addEventListener('objectChange', () => this.onGizmoChange());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.bindInput();
  }

  setView(view, mode) {
    if (this.view && this.view.scene) { this.view.scene.remove(this.gizmoHelper); this.view.scene.remove(this.gizmoProxy); }
    this.clearSelectionHelpers();
    this.view = view;
    this.mode = mode;
    if (view && mode === 'edit') { view.scene.add(this.gizmoProxy); view.scene.add(this.gizmoHelper); }
    this.gizmo.detach();
    this.refreshSelection();
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  applyCameraAngles() {
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }

  // ---------------------------------------------------------------- input (edit camera)
  bindInput() {
    const c = this.canvas;
    let rmb = false, mmb = false, last = null, downAt = null, moved = false, dragPart = null;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'edit') return;
      c.focus();
      last = { x: e.clientX, y: e.clientY };
      downAt = { x: e.clientX, y: e.clientY };
      moved = false;
      if (e.button === 2) { rmb = true; c.setPointerCapture(e.pointerId); }
      else if (e.button === 1) { mmb = true; e.preventDefault(); c.setPointerCapture(e.pointerId); }
      else if (e.button === 0 && this.tool === 'terrain') {
        const p = this.groundPoint(e.clientX, e.clientY);
        const hit = this.pick(e.clientX, e.clientY, { includeLocked: true });
        this.painting = { last: p.clone() };
        c.setPointerCapture(e.pointerId);
        this.app.history.begin('Terrain Brush');
        import('./terrain-tools.js').then((m) => { this.terrainTools = m; m.stroke(this.app, p, hit && hit.normal); });
      } else if (e.button === 0 && !this.gizmo.dragging && !this.gizmo.axis) {
        const hit = this.pick(e.clientX, e.clientY);
        if (hit && this.app.selection.has(this.selectTarget(hit.inst, e.altKey)) && (this.tool === 'select' || this.tool === 'move')) {
          dragPart = { start: hit.point.clone(), began: false };
          c.setPointerCapture(e.pointerId);
        }
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (this.mode !== 'edit' || !last) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      if (Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) > 4) moved = true;
      if (this.painting && this.terrainTools) {
        const p = this.groundPoint(e.clientX, e.clientY);
        if (p.distanceTo(this.painting.last) > this.terrainTools.brush.radius * 0.7) {
          const hit = this.pick(e.clientX, e.clientY, { includeLocked: true });
          this.painting.last = p.clone();
          this.terrainTools.stroke(this.app, p, hit && hit.normal);
        }
        return;
      }
      if (rmb) { this.yaw -= dx * 0.005; this.pitch -= dy * 0.005; this.applyCameraAngles(); }
      else if (mmb) {
        const s = Math.max(0.05, this.focusDistance() * 0.0016);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
        this.camera.position.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
      } else if (dragPart && moved) {
        if (!dragPart.began) { dragPart.began = true; this.app.history.begin('Drag'); this.dragOrigin = this.app.selection.list().map((i) => [i, i.isA('BasePart') ? i.get('CFrame') : null]); }
        this.dragSelection(e.clientX, e.clientY);
      }
    });
    const up = (e) => {
      if (this.mode !== 'edit') return;
      if (e.button === 0 && !moved && !this.gizmo.dragging && !rmb && !mmb && !dragPart?.began && last) {
        const hit = this.pick(e.clientX, e.clientY);
        const target = hit ? this.selectTarget(hit.inst, e.altKey) : null;
        if (e.shiftKey || e.ctrlKey || e.metaKey) { if (target) this.app.selection.toggle(target); }
        else this.app.selection.set(target ? [target] : []);
      }
      if (this.painting) { this.painting = null; this.app.history.commit(); }
      if (dragPart && dragPart.began) this.app.history.commit();
      dragPart = null;
      rmb = false; mmb = false; last = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      if (this.mode !== 'edit') return;
      e.preventDefault();
      const dir = this.rayDir(e.clientX, e.clientY);
      const step = Math.max(1, this.focusDistance() * 0.12) * Math.sign(e.deltaY) * -1;
      this.camera.position.addScaledVector(dir, step);
    }, { passive: false });
    c.addEventListener('keydown', (e) => {
      if (this.mode !== 'edit') return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'q', 'e', 'shift'].includes(k) && !e.ctrlKey && !e.metaKey) this.keys.add(k);
      if (k === 'f' && !e.ctrlKey) { this.focusSelection(); e.preventDefault(); }
    });
    c.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    c.addEventListener('blur', () => this.keys.clear());
    // drag & drop files / toolbox items onto the viewport
    c.addEventListener('dragover', (e) => { e.preventDefault(); });
    c.addEventListener('drop', (e) => { e.preventDefault(); this.app.onViewportDrop(e, this.groundPoint(e.clientX, e.clientY)); });
  }

  /** Top-level model under Workspace unless Alt is held (Roblox Studio behaviour). */
  selectTarget(inst, alt) {
    if (!inst) return null;
    if (alt) return inst;
    let t = inst;
    for (let p = inst.parent; p && p.ClassName !== 'Workspace'; p = p.parent) if (p.isA('Model') && p.ClassName !== 'Workspace') t = p;
    return t;
  }

  focusDistance() {
    const sel = this.app.selection.list();
    const b = this.app.boundsOf(sel);
    if (b) return this.camera.position.distanceTo(new THREE.Vector3(b.center.X, b.center.Y, b.center.Z));
    return 30;
  }

  focusSelection() {
    const b = this.app.boundsOf(this.app.selection.list());
    if (!b) return;
    const c = new THREE.Vector3(b.center.X, b.center.Y, b.center.Z);
    const r = Math.max(2, b.size.Magnitude * 0.6);
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
    this.camera.position.copy(c).addScaledVector(back, r * 2.2);
  }

  rayDir(x, y) {
    const r = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector3(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1, 0.5).unproject(this.camera);
    return v.sub(this.camera.position).normalize();
  }
  raycaster(x, y) {
    const r = this.canvas.getBoundingClientRect();
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), this.camera);
    return rc;
  }
  pick(x, y, { exclude = null, includeLocked = false } = {}) {
    if (!this.view) return null;
    const hits = this.raycaster(x, y).intersectObjects(this.view.root.children, true);
    for (const hit of hits) {
      let o = hit.object;
      while (o && !o.userData.inst) o = o.parent;
      if (!o) continue;
      const inst = o.userData.inst;
      if (!includeLocked && inst.props.Locked) continue;
      if (exclude && exclude(inst)) continue;
      if (!hit.object.visible || (hit.object.material && hit.object.material.visible === false)) continue;
      return { inst, point: hit.point, normal: hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : UP.clone() };
    }
    return null;
  }
  groundPoint(x, y) {
    const hit = this.pick(x, y, { includeLocked: true });
    if (hit) return hit.point;
    const rc = this.raycaster(x, y);
    const p = new THREE.Vector3();
    return rc.ray.intersectPlane(new THREE.Plane(UP, 0), p) ? p : this.camera.position.clone().addScaledVector(rc.ray.direction, 20);
  }

  /** Drag the selection over surfaces under the mouse. */
  dragSelection(x, y) {
    const sel = this.app.selection;
    const items = this.dragOrigin.filter(([i]) => i.isA('BasePart') || i.isA('Model'));
    if (!items.length) return;
    const hit = this.pick(x, y, { includeLocked: true, exclude: (i) => sel.list().some((s) => s === i || i.isDescendantOf(s)) });
    let p;
    if (hit) p = hit.point;
    else {
      const rc = this.raycaster(x, y); p = new THREE.Vector3();
      if (!rc.ray.intersectPlane(new THREE.Plane(UP, 0), p)) return;
    }
    const b = this.app.boundsOf(sel.list());
    if (!b) return;
    const snap = this.app.settings.get('moveSnap');
    const sx = (v) => (snap > 0 ? Math.round(v / snap) * snap : v);
    const target = new Vector3(sx(p.x), p.y + b.size.Y / 2, sx(p.z));
    const delta = target.sub(b.center);
    if (delta.Magnitude < 1e-4) return;
    this.app.translateSelection(delta);
  }

  // ---------------------------------------------------------------- gizmo
  setTool(tool) {
    this.tool = tool;
    this.refreshSelection();
  }
  refreshSelection() {
    this.clearSelectionHelpers();
    if (!this.view || this.mode !== 'edit') { this.gizmo.detach(); return; }
    const sel = this.app.selection.list();
    for (const inst of sel) this.addSelectionHelper(inst);
    const b = this.app.boundsOf(sel);
    if (b && this.tool !== 'select' && this.tool !== 'terrain') {
      const pivot = this.app.pivotOf(sel);
      cframeToMatrix(pivot, this.gizmoProxy.matrix);
      this.gizmoProxy.matrix.decompose(this.gizmoProxy.position, this.gizmoProxy.quaternion, this.gizmoProxy.scale);
      this.gizmoProxy.scale.set(1, 1, 1);
      this.gizmoProxy.updateMatrixWorld(true);
      this.gizmo.setMode(this.tool === 'move' ? 'translate' : this.tool === 'scale' ? 'scale' : 'rotate');
      this.gizmo.setSpace(this.tool === 'move' && !this.app.settings.get('localSpace') ? 'world' : 'local');
      const ms = this.app.settings.get('moveSnap'), rs = this.app.settings.get('rotateSnap');
      this.gizmo.setTranslationSnap(ms > 0 ? ms : null);
      this.gizmo.setRotationSnap(rs > 0 ? THREE.MathUtils.degToRad(rs) : null);
      this.gizmo.setScaleSnap(null);
      this.gizmo.attach(this.gizmoProxy);
      this.gizmoStart = { pos: this.gizmoProxy.position.clone(), quat: this.gizmoProxy.quaternion.clone(), pivot };
    } else this.gizmo.detach();
  }
  clearSelectionHelpers() {
    for (const hp of this.selectionHelpers.values()) { hp.parent?.remove(hp); hp.geometry.dispose(); }
    this.selectionHelpers.clear();
  }
  addSelectionHelper(inst) {
    const parts = inst.isA('BasePart') ? [inst] : inst.descendants().filter((d) => d.isA('BasePart'));
    for (const p of parts.slice(0, 400)) {
      const s = p.props.Size;
      const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(s.X + 0.04, s.Y + 0.04, s.Z + 0.04));
      const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: inst === p ? 0x2fa8ff : 0x7cc6ff, depthTest: false, transparent: true, opacity: 0.95 }));
      line.renderOrder = 999;
      line.matrixAutoUpdate = false;
      line.userData.part = p;
      this.view.scene.add(line);
      this.selectionHelpers.set(p, line);
    }
  }
  updateSelectionHelpers() {
    for (const [p, line] of this.selectionHelpers) {
      if (!p.props.CFrame) continue;
      cframeToMatrix(p.props.CFrame, line.matrix);
      line.matrixWorldNeedsUpdate = true;
    }
  }
  onGizmoDragging(dragging) {
    if (dragging) {
      this.app.history.begin(this.tool === 'move' ? 'Move' : this.tool === 'scale' ? 'Resize' : 'Rotate');
      this.gizmoStart = { pos: this.gizmoProxy.position.clone(), quat: this.gizmoProxy.quaternion.clone(), pivot: this.app.pivotOf(this.app.selection.list()), scale: new THREE.Vector3(1, 1, 1) };
      this.gizmoBase = this.app.selection.list().map((i) => [i, i.isA('BasePart') ? { cf: i.get('CFrame'), size: i.get('Size') } : { pivot: this.app.pivotOf([i]) }]);
    } else {
      this.app.history.commit();
      this.gizmoProxy.scale.set(1, 1, 1);
      this.refreshSelection();
    }
  }
  onGizmoChange() {
    if (!this.gizmo.dragging || !this.gizmoStart) return;
    const p = this.gizmoProxy;
    if (this.tool === 'scale') {
      const s = p.scale;
      this.app.scaleSelection(this.gizmoBase, new Vector3(s.x, s.y, s.z));
      return;
    }
    const start = this.gizmoStart.pivot;
    const m = new THREE.Matrix4().compose(p.position, p.quaternion, new THREE.Vector3(1, 1, 1));
    const e = m.elements;
    const now = new CFrame(e[12], e[13], e[14], e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]);
    const delta = now.mul(start.inverse());
    this.app.transformSelection(this.gizmoBase, delta);
    this.updateSelectionHelpers();
  }

  // ---------------------------------------------------------------- frame
  update(dt) {
    if (this.mode === 'edit' && !this.gizmo.dragging) {
      const k = this.keys;
      if (k.size && document.activeElement === this.canvas) {
        const speed = (k.has('shift') ? 8 : 40) * dt * Math.max(1, this.app.settings.get('cameraSpeed'));
        const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
        const r = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        if (k.has('w')) this.camera.position.addScaledVector(f, speed);
        if (k.has('s')) this.camera.position.addScaledVector(f, -speed);
        if (k.has('d')) this.camera.position.addScaledVector(r, speed);
        if (k.has('a')) this.camera.position.addScaledVector(r, -speed);
        if (k.has('e')) this.camera.position.addScaledVector(UP, speed);
        if (k.has('q')) this.camera.position.addScaledVector(UP, -speed);
      }
      this.updateSelectionHelpers();
    }
  }

  render() {
    const v = this.view;
    if (!v) return;
    v.flush();
    const lv = v.lightingView;
    lv.follow(this.mode === 'edit' ? this.camera.position.clone().addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion), 40) : (this.focus || this.camera.position));
    this.renderer.toneMappingExposure = 1.05 * lv.exposure;
    const filter = lv.cssFilter();
    if (this.canvas.style.filter !== filter) this.canvas.style.filter = filter;
    this.renderer.render(v.scene, this.camera);
  }

  /** Point the lighting / shadow camera follows in play mode. */
  setFocus(x, y, z) { (this.focus ||= new THREE.Vector3()).set(x, y, z); }

  /** Workspace camera CFrame for play mode. */
  setCameraCFrame(cf, fov) {
    const m = cframeToMatrix(cf);
    m.decompose(this.camera.position, this.camera.quaternion, new THREE.Vector3());
    if (fov && Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    this.camera.updateMatrixWorld();
  }
  cameraCFrame() {
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorld.elements;
    return new CFrame(e[12], e[13], e[14], e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]);
  }
}
