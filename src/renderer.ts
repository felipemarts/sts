import './index.css';
import { el } from './ui/dom';
import { createListenTab, Tab } from './ui/listen';
import { createReadTab } from './ui/read';
import { createCloneTab } from './ui/clone';
import { createSettingsTab } from './ui/settings';

const app = document.getElementById('app')!;
const tabbar = el('div', { class: 'tabbar' });
const panels = el('div', { class: 'panels' });

type Key = 'listen' | 'read' | 'clone' | 'settings';

const goToSettings = () => activate('settings');

const listen = createListenTab(goToSettings);
const read = createReadTab(goToSettings);
const clone = createCloneTab();
// Quando modelos mudam nas Configurações, atualiza os selects das outras abas.
const settings = createSettingsTab(() => {
  listen.refresh();
  read.refresh();
});

const registry: Record<Key, { label: string; tab: Tab; button: HTMLElement }> = {
  listen: { label: '🎙  Escutar', tab: listen, button: null as unknown as HTMLElement },
  read: { label: '🔊  Ler', tab: read, button: null as unknown as HTMLElement },
  clone: { label: '🧬  Clonar', tab: clone, button: null as unknown as HTMLElement },
  settings: { label: '⚙  Configurações', tab: settings, button: null as unknown as HTMLElement },
};

function activate(key: Key) {
  for (const k of Object.keys(registry) as Key[]) {
    const active = k === key;
    registry[k].button.classList.toggle('active', active);
    registry[k].tab.element.classList.toggle('active', active);
  }
  registry[key].tab.refresh();
}

// Monta a barra: Escutar | Ler | Clonar ...... Configurações
for (const key of ['listen', 'read', 'clone'] as Key[]) {
  const btn = el('div', { class: 'tab', onClick: () => activate(key) }, [registry[key].label]);
  registry[key].button = btn;
  tabbar.append(btn);
}
tabbar.append(el('div', { class: 'spacer' }));
{
  const btn = el('div', { class: 'tab', onClick: () => activate('settings') }, [
    registry.settings.label,
  ]);
  registry.settings.button = btn;
  tabbar.append(btn);
}

panels.append(listen.element, read.element, clone.element, settings.element);
app.append(tabbar, panels);

activate('listen');
