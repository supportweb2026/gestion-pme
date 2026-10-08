/**
 * Horloge logique hybride (HLC).
 *
 * Chaque modification reçoit un horodatage HLC sous forme de chaîne triable :
 *   "<millisecondes sur 15 chiffres>-<compteur sur 5 chiffres>-<identifiant appareil>"
 * La comparaison de deux chaînes donne l'ordre des modifications, même si les
 * horloges des appareils sont légèrement décalées, et départage deux appareils
 * qui écrivent à la même milliseconde grâce à l'identifiant d'appareil.
 */
export type Hlc = string;

const MS_WIDTH = 15;
const COUNTER_WIDTH = 5;

export function encodeHlc(ms: number, counter: number, deviceId: string): Hlc {
  return `${String(ms).padStart(MS_WIDTH, "0")}-${String(counter).padStart(COUNTER_WIDTH, "0")}-${deviceId}`;
}

export function decodeHlc(hlc: Hlc): { ms: number; counter: number; deviceId: string } {
  const ms = Number(hlc.slice(0, MS_WIDTH));
  const counter = Number(hlc.slice(MS_WIDTH + 1, MS_WIDTH + 1 + COUNTER_WIDTH));
  const deviceId = hlc.slice(MS_WIDTH + COUNTER_WIDTH + 2);
  return { ms, counter, deviceId };
}

export function isValidHlc(value: unknown): value is Hlc {
  return typeof value === "string" && /^\d{15}-\d{5}-[A-Za-z0-9_-]{1,64}$/.test(value);
}

export class HlcClock {
  readonly deviceId: string;
  private readonly now: () => number;
  private lastMs = 0;
  private counter = 0;

  constructor(deviceId: string, now: () => number = Date.now, initial?: Hlc) {
    this.deviceId = deviceId;
    this.now = now;
    if (initial) this.observe(initial);
  }

  /** Nouvel horodatage strictement supérieur à tous ceux déjà émis ou observés. */
  tick(): Hlc {
    const t = this.now();
    if (t > this.lastMs) {
      this.lastMs = t;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return encodeHlc(this.lastMs, this.counter, this.deviceId);
  }

  /** Intègre un horodatage reçu d'un autre appareil pour rester en avance sur lui. */
  observe(remote: Hlc): void {
    const { ms, counter } = decodeHlc(remote);
    if (ms > this.lastMs) {
      this.lastMs = ms;
      this.counter = counter;
    } else if (ms === this.lastMs && counter > this.counter) {
      this.counter = counter;
    }
  }

  /** Dernier horodatage connu, à sauvegarder pour reprendre après redémarrage. */
  current(): Hlc {
    return encodeHlc(this.lastMs, this.counter, this.deviceId);
  }
}
