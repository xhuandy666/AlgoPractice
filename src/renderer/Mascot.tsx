import { useId, type ReactElement } from 'react';
import './mascot.css';

export type MascotMood = 'happy' | 'cheer' | 'sad' | 'think' | 'sleep';

const mouths: Record<MascotMood, ReactElement> = {
  happy: <path className="mascot-line" d="M51 91 Q60 100 69 91" />,
  cheer: <g><path className="mascot-mouth" d="M49 88 Q60 108 71 88 Z" /><path className="mascot-tongue" d="M54 97 Q60 92 66 97 Q60 104 54 97 Z" /></g>,
  sad: <path className="mascot-line" d="M52 97 Q60 89 68 97" />,
  think: <circle className="mascot-mouth" cx="62" cy="94" r="3.6" />,
  sleep: <path className="mascot-line" d="M54 94 Q60 97 66 94" />
};

/** 小炼, the decorative flame mascot. Always aria-hidden; surrounding text carries the meaning. */
export function Mascot({ mood = 'happy', size = 96, className = '' }: { mood?: MascotMood; size?: number; className?: string }) {
  const id = useId().replace(/:/g, ''), body = `mascot-body-${id}`, core = `mascot-core-${id}`;
  const look = mood === 'think' ? 3 : 0, lookY = mood === 'think' ? -3 : mood === 'sad' ? 2 : 0;
  return <span className={`mascot ${className}`.trim()} data-mood={mood} style={{ width: size, height: size * 1.08 }} aria-hidden="true">
    <svg viewBox="0 0 120 130" width={size} height={size * 1.08}>
      <defs>
        <linearGradient id={body} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={mood === 'sad' ? '#ffb86b' : '#ffc53d'} /><stop offset="1" stopColor={mood === 'sad' ? '#f08a3c' : '#ff7a00'} /></linearGradient>
        <radialGradient id={core} cx="0.5" cy="0.4" r="0.6"><stop offset="0" stopColor="#fff6d6" /><stop offset="1" stopColor="#ffd970" /></radialGradient>
      </defs>
      <ellipse className="mascot-shadow" cx="60" cy="125" rx="30" ry="4" />
      <g className="mascot-figure">
        {mood === 'cheer' && <g className="mascot-arms"><path d="M27 86 Q12 72 14 56" /><path d="M93 86 Q108 72 106 56" /></g>}
        {mood !== 'cheer' && <g className="mascot-arms mascot-arms-rest"><path d="M25 92 Q16 98 18 106" /><path d="M95 92 Q104 98 102 106" /></g>}
        <path fill={`url(#${body})`} d="M60 6 C67 27 85 35 95 53 C105 71 104 93 92 107 C82 118 70 122 60 122 C50 122 38 118 28 107 C16 93 16 73 26 59 C30 53 34 51 39 50 C37 58 40 64 46 65 C44 50 49 30 60 6 Z" />
        <ellipse fill={`url(#${core})`} cx="60" cy="96" rx="25" ry="22" />
        {mood === 'sleep'
          ? <g className="mascot-line"><path d="M42 76 Q48 80 54 76" /><path d="M66 76 Q72 80 78 76" /></g>
          : <g className="mascot-eyes">
            <ellipse className="mascot-eye" cx="48" cy="75" rx="9" ry="10.5" /><ellipse className="mascot-eye" cx="72" cy="75" rx="9" ry="10.5" />
            <circle className="mascot-pupil" cx={49 + look} cy={77 + lookY} r="5" /><circle className="mascot-pupil" cx={73 + look} cy={77 + lookY} r="5" />
            <circle className="mascot-glint" cx={51 + look} cy={74 + lookY} r="1.8" /><circle className="mascot-glint" cx={75 + look} cy={74 + lookY} r="1.8" />
          </g>}
        {mood === 'sad' && <g className="mascot-line mascot-brow"><path d="M40 63 L52 66" /><path d="M80 63 L68 66" /></g>}
        {mood === 'think' && <g className="mascot-line mascot-brow"><path d="M41 62 Q48 58 54 62" /><path d="M66 60 Q73 57 80 61" /></g>}
        <ellipse className="mascot-cheek" cx="37" cy="90" rx="6" ry="3.6" /><ellipse className="mascot-cheek" cx="83" cy="90" rx="6" ry="3.6" />
        {mouths[mood]}
      </g>
      {mood === 'cheer' && <g className="mascot-sparkles"><path d="M14 30 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" /><path d="M104 22 l2.4 5.6 5.6 2.4 -5.6 2.4 -2.4 5.6 -2.4 -5.6 -5.6 -2.4 5.6 -2.4 Z" /><path d="M100 104 l2 4.5 4.5 2 -4.5 2 -2 4.5 -2 -4.5 -4.5 -2 4.5 -2 Z" /></g>}
      {mood === 'sleep' && <g className="mascot-zzz"><text x="88" y="30">z</text><text x="98" y="18">z</text></g>}
      {mood === 'think' && <g className="mascot-dots"><circle cx="96" cy="40" r="3" /><circle cx="104" cy="30" r="4" /><circle cx="112" cy="18" r="5" /></g>}
    </svg>
  </span>;
}
