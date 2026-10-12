// Icons: Lucide (https://lucide.dev, ISC licence), imported one by one so Vite bundles only these.
// Usage: App.icon('home', 28). The names below are the dashboard's own; each maps to a Lucide icon.
import {
  House, Calendar, SquareCheckBig, ShoppingCart, Image, SlidersHorizontal, Lightbulb, Lock, LockOpen,
  Warehouse, Blinds, Thermometer, Cctv, Music, Plus, Minus, ChevronLeft, ChevronRight, X, Check, Heart,
  Star, MapPin, Car, Droplet, Package, DoorClosed, Bell, Mic, Play, Pause, Undo2, Clock, User, Zap, Film,
  Utensils, Sunrise, LogOut, Settings, RefreshCw, Trash2, Pencil, Link, Sun, Cloud, CloudRain, CloudSun,
  Moon, CloudSnow, CloudLightning, Fan, Power,
} from 'lucide';

const MAP = {
  home: House, calendar: Calendar, tasks: SquareCheckBig, cart: ShoppingCart, photo: Image,
  sliders: SlidersHorizontal, bulb: Lightbulb, lock: Lock, unlock: LockOpen, garage: Warehouse,
  blinds: Blinds, thermo: Thermometer, camera: Cctv, music: Music, plus: Plus, minus: Minus,
  left: ChevronLeft, right: ChevronRight, x: X, check: Check, heart: Heart, star: Star, pin: MapPin,
  car: Car, drop: Droplet, box: Package, door: DoorClosed, bell: Bell, mic: Mic, play: Play, pause: Pause,
  undo: Undo2, clock: Clock, person: User, bolt: Zap, film: Film, utensils: Utensils, sunrise: Sunrise,
  away: LogOut, gear: Settings, refresh: RefreshCw, trash: Trash2, edit: Pencil, link: Link,
  // weather
  sun: Sun, cloud: Cloud, rain: CloudRain, partly: CloudSun, moon: Moon, snow: CloudSnow, storm: CloudLightning,
  // devices
  fan: Fan, power: Power,
};
// Media controls read better solid.
const FILLED = { play: true, pause: true };

function attrs(a) {
  return Object.keys(a).map((k) => ' ' + k + '="' + String(a[k]).replace(/"/g, '&quot;') + '"').join('');
}
// Lucide icon node ([[tag, attrs], ...]) → SVG body markup, built once at startup.
window.ICONS = {};
for (const name of Object.keys(MAP)) {
  const body = MAP[name].map(([tag, a]) => '<' + tag + attrs(a) + '/>').join('');
  window.ICONS[name] = FILLED[name] ? '<g fill="currentColor">' + body + '</g>' : body;
}
