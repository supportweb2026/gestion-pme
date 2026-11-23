/**
 * Zone de signature : le client signe au doigt, au stylet ou à la souris.
 * Rend un tracé PNG sur fond transparent, prêt à être imprimé sur le document.
 */
import { useEffect, useRef, useState } from "react";

const W = 560;
const H = 200;

export function SignaturePad({ onChange, label = "Signature" }: { onChange: (image: string | null) => void; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const ctx = ref.current!.getContext("2d")!;
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#101d36";
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = point(e);
    // Un simple point compte comme un début de tracé.
    const ctx = ref.current!.getContext("2d")!;
    ctx.beginPath();
    ctx.arc(last.current.x, last.current.y, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = "#101d36";
    ctx.fill();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    const p = point(e);
    const ctx = ref.current!.getContext("2d")!;
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    setEmpty(false);
    onChange(ref.current!.toDataURL("image/png"));
  };
  const clear = () => {
    ref.current!.getContext("2d")!.clearRect(0, 0, W, H);
    setEmpty(true);
    onChange(null);
  };

  return (
    <div className="sign-pad">
      <div className="sign-pad-head">
        <span>{label}</span>
        <button type="button" className="link" onClick={clear} disabled={empty}>Effacer</button>
      </div>
      <canvas
        ref={ref} width={W} height={H} role="img" aria-label="Zone de signature" data-testid="sign-canvas"
        onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerLeave={end}
      />
      {empty && <p className="sign-pad-hint" aria-hidden="true">Signez ici, au doigt ou à la souris</p>}
    </div>
  );
}
