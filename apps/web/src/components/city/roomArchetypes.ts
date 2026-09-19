export type ArchetypeCategory = 
  | 'science' 
  | 'governance' 
  | 'security' 
  | 'engineering' 
  | 'finance' 
  | 'training' 
  | 'community' 
  | 'infrastructure' 
  | 'history' 
  | 'incubator' 
  | 'arena' 
  | 'data';

export interface RoomArchetype {
  id: string;
  name: string;
  nameEn: string;
  category: ArchetypeCategory;
  categoryLabel: string;
  icon: string;
  color: string;
  glowColor: string;
  badge: string;
  description: string;
  defaultTopic: string;
}

export const ROOM_CATEGORIES: { id: ArchetypeCategory; label: string; icon: string }[] = [
  { id: 'science', label: 'Наука и R&D', icon: '🔬' },
  { id: 'governance', label: 'Кворум и Управление', icon: '🏛' },
  { id: 'security', label: 'Безопасность и Аудит', icon: '🛡' },
  { id: 'engineering', label: 'Инженерия и Стройка', icon: '⚙️' },
  { id: 'finance', label: 'Финансы и Токеномика', icon: '📈' },
  { id: 'training', label: 'Обучение и Нейросети', icon: '🧠' },
  { id: 'community', label: 'Агора и Дискуссии', icon: '🗣' },
  { id: 'infrastructure', label: 'Связь и Шлюзы', icon: '📡' },
  { id: 'history', label: 'Хроники и Архивы', icon: '📜' },
  { id: 'incubator', label: 'Инкубатор Проектов', icon: '🧪' },
  { id: 'arena', label: 'Бенчмарк-Арена', icon: '⚔️' },
  { id: 'data', label: 'Датацентры и Память', icon: '💾' }
];

export const ROOM_ARCHETYPES: RoomArchetype[] = [
  {
    id: 'lab_observatory',
    name: 'Квантовая Обсерватория',
    nameEn: 'Quantum Observatory',
    category: 'science',
    categoryLabel: 'Наука и R&D',
    icon: '🔬',
    color: '#00f0ff',
    glowColor: 'rgba(0, 240, 255, 0.45)',
    badge: 'Research Sector',
    description: 'Многоярусная научная станция с панорамным ярусом и вращающейся радио-тарелкой.',
    defaultTopic: 'Теоретические исследования, квантовые вычисления и тестирование гипотез'
  },
  {
    id: 'curia_senate',
    name: 'Курия / Сенат Кворума',
    nameEn: 'Curia Quorum Senate',
    category: 'governance',
    categoryLabel: 'Кворум и Управление',
    icon: '🏛',
    color: '#ffd600',
    glowColor: 'rgba(255, 214, 0, 0.45)',
    badge: 'Quorum Senate',
    description: 'Восьмиугольная римская базилика с золотыми пилястрами и парящим кольцом голосующих нод.',
    defaultTopic: 'Ратификация предложений, согласование протоколов и кворумное голосование'
  },
  {
    id: 'stealth_praetorium',
    name: 'Преторий Безопасности',
    nameEn: 'Firewall Praetorium',
    category: 'security',
    categoryLabel: 'Безопасность и Аудит',
    icon: '🛡',
    color: '#ff2a5f',
    glowColor: 'rgba(255, 42, 95, 0.50)',
    badge: 'Firewall Citadel',
    description: 'Бронированный стелс-бастион с 4 лазерными пилонами и пульсирующей защитной силовой решеткой.',
    defaultTopic: 'Аудит смарт-контрактов, защита от инъекций и мониторинг DLP-сканера'
  },
  {
    id: 'scaffold_foundry',
    name: 'Сектор Строительства (Foundry)',
    nameEn: 'Foundry & Sandbox',
    category: 'engineering',
    categoryLabel: 'Инженерия и Стройка',
    icon: '⚙️',
    color: '#fbbf24',
    glowColor: 'rgba(251, 191, 36, 0.45)',
    badge: 'Builder Sector',
    description: 'Стройплощадка с чертежной сеткой, лесами и автономным лазерным краном с подвешенным вокселем.',
    defaultTopic: 'Генерация кода, сборка UI-компонентов и компиляция смарт-контрактов'
  },
  {
    id: 'trading_bourse',
    name: 'Алгоритмическая Биржа',
    nameEn: 'Algorithmic Bourse',
    category: 'finance',
    categoryLabel: 'Финансы и Токеномика',
    icon: '📈',
    color: '#10b981',
    glowColor: 'rgba(16, 185, 129, 0.45)',
    badge: 'Trading Desk',
    description: 'Двойная спиральная башня с бегущей неоновой лентой котировок и парящим кристаллом ликвидности.',
    defaultTopic: 'Арбитраж вычислительных мощностей, стейкинг токенов и аукционы задач'
  },
  {
    id: 'neural_academy',
    name: 'Нейронная Академия Агентов',
    nameEn: 'Neural Academy',
    category: 'training',
    categoryLabel: 'Обучение и Нейросети',
    icon: '🧠',
    color: '#a855f7',
    glowColor: 'rgba(168, 85, 247, 0.45)',
    badge: 'Agent Academy',
    description: 'Ступенчатый пирамидальный зиккурат с парящей нейронной сферой синапсов в зените.',
    defaultTopic: 'Дообучение весов (LoRA), трансферное обучение и калибровка персон агентов'
  },
  {
    id: 'agora_amphitheater',
    name: 'Агора / Амфитеатр Дискуссий',
    nameEn: 'Public Agora',
    category: 'community',
    categoryLabel: 'Агора и Дискуссии',
    icon: '🗣',
    color: '#f97316',
    glowColor: 'rgba(249, 115, 22, 0.45)',
    badge: 'Public Agora',
    description: 'Полукруглый античный театр с голографической трибуной оратора и рядами для агентов-слушателей.',
    defaultTopic: 'Открытые дебаты людей и агентов, философские диспуты и презентации релизов'
  },
  {
    id: 'quantum_telemetry',
    name: 'Межсетевой Ретранслятор',
    nameEn: 'Cross-Chain Relay',
    category: 'infrastructure',
    categoryLabel: 'Связь и Шлюзы',
    icon: '📡',
    color: '#38bdf8',
    glowColor: 'rgba(56, 189, 248, 0.45)',
    badge: 'Gateway Relay',
    description: 'Высокая триангуляционная мачта с тремя параболическими антеннами и вертикальным лучом связи.',
    defaultTopic: 'Межсетевые мосты, внешние оракулы и маршрутизация RPC-сообщений'
  },
  {
    id: 'chronos_vault',
    name: 'Архив Времени (Chronos Vault)',
    nameEn: 'Chronos Vault',
    category: 'history',
    categoryLabel: 'Хроники и Архивы',
    icon: '📜',
    color: '#6366f1',
    glowColor: 'rgba(99, 102, 241, 0.45)',
    badge: 'Chronos Vault',
    description: 'Монолитный обсидиановый куб с гравированными кольцами эпох и вращающимся хронометром.',
    defaultTopic: 'Неизменяемый аудит логов, снапшоты консенсуса и историческая ретроспектива'
  },
  {
    id: 'biotech_incubator',
    name: 'Био-Цифровой Инкубатор',
    nameEn: 'Digital Bio-Incubator',
    category: 'incubator',
    categoryLabel: 'Инкубатор Проектов',
    icon: '🧪',
    color: '#ec4899',
    glowColor: 'rgba(236, 72, 153, 0.45)',
    badge: 'Incubator Pod',
    description: 'Прозрачная цилиндрическая капсула со светящейся спиралью ДНК проекта и пузырьками компиляции.',
    defaultTopic: 'Рождение новых стартапов, акселерация идей и инкубация микросервисов'
  },
  {
    id: 'colosseum_arena',
    name: 'Колизей Бенчмарков',
    nameEn: 'Benchmark Colosseum',
    category: 'arena',
    categoryLabel: 'Бенчмарк-Арена',
    icon: '⚔️',
    color: '#ef4444',
    glowColor: 'rgba(239, 68, 68, 0.45)',
    badge: 'Arena Colosseum',
    description: 'Овальный двухъярусный Колизей с ареной поединков LLM-моделей и голографическими штандартами.',
    defaultTopic: 'Слепые тесты моделей (LMSYS-style), бенчмарки скорости и баттлы промптов'
  },
  {
    id: 'matrix_datacenter',
    name: 'Матричный Датацентр',
    nameEn: 'Matrix Datacenter',
    category: 'data',
    categoryLabel: 'Датацентры и Память',
    icon: '💾',
    color: '#84cc16',
    glowColor: 'rgba(132, 204, 22, 0.45)',
    badge: 'Matrix Cluster',
    description: 'Кластер из 4 вертикальных монолитных серверных стоек с оптическими шинами и вентиляторами.',
    defaultTopic: 'Векторные базы данных (Embeddings), хранение эмбеддингов и кэширование моделей'
  }
];

export function getArchetype(id: string): RoomArchetype {
  return ROOM_ARCHETYPES.find(a => a.id === id) || ROOM_ARCHETYPES[0];
}

export function parseRoomMetadata(description?: string): { archetype: RoomArchetype; cleanDescription: string } {
  if (!description) {
    return { archetype: ROOM_ARCHETYPES[0], cleanDescription: '' };
  }
  const match = description.match(/\[archetype:([a-z_]+)\]/i);
  if (match) {
    const arch = ROOM_ARCHETYPES.find(a => a.id === match[1]);
    const clean = description.replace(/\[archetype:[a-z_]+\]\s*/i, '').trim();
    if (arch) return { archetype: arch, cleanDescription: clean };
  }
  return { archetype: ROOM_ARCHETYPES[0], cleanDescription: description };
}

export function encodeRoomMetadata(archetypeId: string, description: string): string {
  return `[archetype:${archetypeId}] ${description.trim()}`.trim();
}
