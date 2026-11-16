interface Particle { x: number; y: number; vx: number; vy: number; rotation: number; spin: number; width: number; height: number; color: string; round: boolean; age: number; ttl: number; wobble: number }
export interface BurstOptions { x: number; y: number; count: number; angle?: number; spread?: number; power?: number; colors: string[] }

/** A small canvas particle system. It owns one animation frame loop that stops when the sky is clear. */
export class Confetti {
  private particles: Particle[] = [];
  private frame = 0;
  private readonly context: CanvasRenderingContext2D | null;
  constructor(private readonly canvas: HTMLCanvasElement) { this.context = canvas.getContext('2d'); }

  burst({ x, y, count, angle = -90, spread = 70, power = 13, colors }: BurstOptions) {
    if (!this.context || !colors.length) return;
    for (let index = 0; index < count; index++) {
      const direction = (angle + (Math.random() - 0.5) * spread) * Math.PI / 180, speed = power * (0.45 + Math.random() * 0.75);
      this.particles.push({
        x, y, vx: Math.cos(direction) * speed, vy: Math.sin(direction) * speed,
        rotation: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 0.4,
        width: 5 + Math.random() * 6, height: 8 + Math.random() * 8, color: colors[index % colors.length],
        round: Math.random() < 0.28, age: 0, ttl: 90 + Math.random() * 60, wobble: Math.random() * Math.PI * 2,
      });
    }
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  stop() { cancelAnimationFrame(this.frame); this.frame = 0; this.particles = []; this.context?.clearRect(0, 0, this.canvas.width, this.canvas.height); }

  private tick = () => {
    const context = this.context!, ratio = window.devicePixelRatio || 1, width = window.innerWidth, height = window.innerHeight;
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio); this.canvas.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    this.particles = this.particles.filter(particle => particle.age < particle.ttl && particle.y < height + 40);
    for (const particle of this.particles) {
      particle.age++; particle.wobble += 0.12;
      particle.vx *= 0.985; particle.vy = particle.vy * 0.985 + 0.32;
      particle.x += particle.vx + Math.sin(particle.wobble) * 0.6; particle.y += particle.vy;
      particle.rotation += particle.spin;
      const fade = Math.min(1, (particle.ttl - particle.age) / 24);
      context.save(); context.globalAlpha = fade; context.fillStyle = particle.color;
      context.translate(particle.x, particle.y); context.rotate(particle.rotation);
      if (particle.round) { context.beginPath(); context.arc(0, 0, particle.width / 2, 0, Math.PI * 2); context.fill(); }
      else context.fillRect(-particle.width / 2, -particle.height / 2, particle.width, particle.height * Math.abs(Math.cos(particle.wobble)) + 2);
      context.restore();
    }
    this.frame = this.particles.length ? requestAnimationFrame(this.tick) : 0;
    if (!this.frame) context.clearRect(0, 0, width, height);
  };
}
