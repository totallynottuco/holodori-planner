import { boostCap, boostRules, defaultBoosts, sampleBoost } from '../hololive/boosts.ts';

// Data/controller adaptation only. The captured wy/Ly and y9/cy components
// still supply the Vue render functions, form controls, dialogs and handlers.
const timers = new WeakMap();
function state(vm) {
  return vm.data[`${vm.account}-boosts`] || defaultBoosts();
}
function preferences(vm) {
  return vm.settings.holodori_boosts?.[vm.kind] || {};
}
function saveState(vm, value) {
  const key = `${vm.account}-boosts`;
  const stamp = new Date().toISOString();
  localStorage.setItem(key, JSON.stringify(value));
  localStorage.setItem('last_update', stamp);
  vm.data[key] = value;
  vm.applyUpdate(stamp);
}
function preference(vm, key, fallback) {
  return preferences(vm)[key] ?? fallback;
}
function setPreference(vm, key, value) {
  vm.setSetting('holodori_boosts', {
    ...vm.settings.holodori_boosts,
    [vm.kind]: { ...preferences(vm), [key]: value },
  });
}
function sample(vm) {
  const record = state(vm)[vm.kind];
  return record
    ? sampleBoost(record, boostCap(vm.kind, state(vm).holoPassport), boostRules[vm.kind].interval, vm.boostNow)
    : null;
}
function recoveryAt(vm, quantity) {
  const current = sample(vm);
  if (!current || !current.nextAt || quantity <= current.amount) return vm.boostNow;
  return current.nextAt + (quantity - current.amount - 1) * boostRules[vm.kind].interval;
}
export function boostState(vm) { return state(vm); }

const boostComputed = {
  boostName() { return boostRules[this.kind].name; },
  holodoriBoostCap() { return boostCap(this.kind, state(this).holoPassport); },
  resinPerDay() { return 86400000 / boostRules[this.kind].interval; },
  resinAmount() { return state(this)[this.kind]?.amount || 0; },
  resinTime() { const record = state(this)[this.kind]; return record ? new Date(record.at).toISOString() : null; },
  computedResin() { return sample(this)?.amount || 0; },
  roundedResin: {
    get() { return this.computedResin; },
    set(value) { this.setResin(value); },
  },
  adjustQuantities: {
    get() { return preference(this, 'adjustQuantities', [-1, 1]); },
    set(value) { setPreference(this, 'adjustQuantities', value); },
  },
  showMinusPlus: {
    get() { return preference(this, 'showMinusPlus', true); },
    set(value) { setPreference(this, 'showMinusPlus', !!value); },
  },
  showRecoveryTimes: {
    get() { return preference(this, 'showRecoveryTimes', true); },
    set(value) { setPreference(this, 'showRecoveryTimes', !!value); },
  },
  recoveryQuantities: {
    get() {
      return [...new Set([...preference(this, 'recoveryQuantities', [1]), this.resinCap])]
        .filter(value => value > 0 && value <= this.resinCap).sort((a, b) => a - b);
    },
    set(value) { setPreference(this, 'recoveryQuantities', value); },
  },
};
const boostWatch = {
  // The captured global mixin declares resinCap/resinInterval in DATA.
  // Vue data takes precedence over a same-name computed property. Keep those
  // actual source fields and update the cap from a uniquely named computed.
  holodoriBoostCap: {immediate:true,handler(value) { this.resinCap = value; }},
};
const boostMethods = {
  setResin(value) {
    const amount = Math.max(0, Math.min(this.resinCap, Math.floor(Number(value) || 0)));
    const now = Date.now();
    saveState(this, { ...state(this), [this.kind]: { amount, at: now } });
    this.boostNow = now;
  },
  addResin(delta) {
    const now = Date.now();
    const record = state(this)[this.kind];
    const current = record ? sampleBoost(record, this.resinCap, boostRules[this.kind].interval, now) : null;
    const amount = Math.max(0, Math.min(this.resinCap, (current?.amount || 0) + Number(delta)));
    const at = current && current.amount < this.resinCap ? current.anchor : now;
    saveState(this, { ...state(this), [this.kind]: { amount, at } });
    this.boostNow = now;
  },
  getIn(quantity) {
    const minutes = Math.max(0, Math.ceil((recoveryAt(this, quantity) - this.boostNow) / 60000));
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
  },
  getTime(quantity) {
    return this.dayjs(recoveryAt(this, quantity)).format(this.settings.hour_format == 24 ? 'HH:mm' : 'hh:mm A');
  },
  setup() {
    this.setResin(0);
    this.editing = true;
    this.$nextTick(() => this.$refs.input?.focus());
  },
  remove() { saveState(this, { ...state(this), [this.kind]: null }); },
};

/** Wrap the ORIGINAL options object; the caller retains its original Ly render. */
export function configureBoostOptions(original) {
  return {
    ...original,
    props: ['estimation', 'game', 'kind'],
    data() { return { ...original.data.call(this), boostNow: Date.now(), resinCap: boostRules[this.kind].cap, resinInterval: boostRules[this.kind].interval / 1000 }; },
    computed: { ...original.computed, ...boostComputed },
    watch: { ...original.watch, ...boostWatch },
    methods: { ...original.methods, ...boostMethods },
    mounted() {
      original.mounted?.call(this);
      const refresh = () => { this.boostNow = Date.now(); };
      const active = { timer: null, sync: null };
      const sync = () => {
        clearInterval(active.timer);
        active.timer = null;
        if (document.hidden) return;
        refresh();
        active.timer = setInterval(refresh, 1000);
      };
      active.sync = sync;
      window.addEventListener('focus', sync);
      document.addEventListener('visibilitychange', sync);
      timers.set(this, active);
      sync();
    },
    beforeUnmount() {
      const active = timers.get(this);
      if (active) {
        clearInterval(active.timer);
        window.removeEventListener('focus', active.sync);
        document.removeEventListener('visibilitychange', active.sync);
        timers.delete(this);
      }
      original.beforeUnmount?.call(this);
    },
  };
}

/** Preserve original settings fields, add/remove handlers and Dialog render. */
export function configureBoostSettings(original) {
  return {
    ...original,
    props: ['game', 'kind'],
    data() {
      return { ...original.data.call(this), boostNow: Date.now(), resinCap: boostRules[this.kind].cap, resinInterval: boostRules[this.kind].interval / 1000, refreshCosts: [], adjustQuantity: -1, recoveryQuantity: 1 };
    },
    computed: { ...original.computed, ...boostComputed },
    watch: { ...original.watch, ...boostWatch },
    methods: { ...original.methods },
  };
}
