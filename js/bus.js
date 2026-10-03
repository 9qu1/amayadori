// 部品どうしの連絡。bus.emit("名前", detail) / bus.on("名前", fn)
const target = new EventTarget();

export const bus = {
  emit(name, detail) {
    target.dispatchEvent(new CustomEvent(name, { detail }));
  },
  on(name, fn) {
    const h = (e) => {
      try { fn(e.detail); } catch (err) { console.error(`[bus] ${name}`, err); }
    };
    target.addEventListener(name, h);
    return () => target.removeEventListener(name, h);
  },
};
