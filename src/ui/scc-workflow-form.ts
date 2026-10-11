import { actionApi, type ActionWorkflow } from '../state/actions-api';
import { button, el } from './scc-shared';
import { field, labeled, remoteOptions, select, statusLine } from './scc-action-form';

/** Shared remote dispatch form for the workflow inspector and Releases shortcut. */
export async function renderRemoteWorkflowForm(
  summary: Pick<ActionWorkflow, 'id' | 'path' | 'name'>,
  host: HTMLElement,
  options: {
    cwd: string | undefined;
    branch: string;
    isCurrent: () => boolean;
    onWorkflowLoaded?: (workflow: ActionWorkflow, host: HTMLElement) => void;
    onAccepted?: () => void;
  },
): Promise<void> {
  const status = statusLine();
  const form = el('div', 'scc-action-form');
  host.append(form, status);
  status.textContent = 'Loading workflow…';
  const valid = () => options.isCurrent() && host.isConnected;
  try {
    const [branches, tags] = await Promise.all([
      remoteOptions(options.cwd, 'branches'), remoteOptions(options.cwd, 'tags'),
    ]);
    if (!valid()) return;
    const ref = select('Remote branch or tag', [
      ...branches.map(b => ({ value: b.name, label: `Branch: ${b.name}` })),
      ...tags.map(t => ({ value: t.name, label: `Tag: ${t.name}` })),
    ]);
    ref.required = true;
    if (branches.some(b => b.name === options.branch)) ref.value = options.branch;
    form.append(labeled('Remote branch or tag', ref));
    const controls = el('div', 'scc-action-form');
    form.append(controls);
    let request = 0;
    const load = async () => {
      const current = ++request;
      const selectedRef = ref.value;
      const active = () => valid() && request === current && ref.value === selectedRef;
      controls.replaceChildren();
      status.textContent = 'Loading workflow inputs…';
      if (!selectedRef) { status.textContent = 'No remote branches or tags are available.'; return; }
      try {
        const result = await actionApi('workflowView', {
          cwd: options.cwd, location: 'remote', id: summary.id, path: summary.path, ref: selectedRef,
        });
        if (!active()) return;
        if (!result.ok || !result.workflow) throw new Error(result.error || 'Could not read workflow.');
        const workflow = result.workflow;
        status.textContent = '';
        if (!workflow.dispatchable || (workflow.state && workflow.state !== 'active')) {
          status.textContent = 'This workflow is not available for manual dispatch on this ref.';
          return;
        }
        const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
        const environments = workflow.inputs?.some(d => d.type === 'environment')
          ? await remoteOptions(options.cwd, 'environments') : [];
        if (!active()) return;
        for (const def of workflow.inputs || []) {
          const label = def.description || def.name;
          let input: HTMLInputElement | HTMLSelectElement;
          if (def.type === 'choice') input = select(label,
            def.options.map(value => ({ value, label: value })),
            String(def.default ?? def.options[0] ?? ''));
          else if (def.type === 'boolean') input = select(label, [
            { value: 'false', label: 'False' }, { value: 'true', label: 'True' },
          ], String(def.default ?? false));
          else if (def.type === 'environment') input = select(label, [
            { value: '', label: 'Select environment' },
            ...environments.map(e => ({ value: e.name, label: e.name })),
          ], String(def.default ?? ''));
          else {
            input = field(label, String(def.default ?? ''), def.type === 'number' ? 'number' : 'text');
            if (def.type === 'number') input.step = 'any';
          }
          input.required = def.required;
          inputs.set(def.name, input);
          controls.append(labeled(`${def.name}${def.required ? ' *' : ''} · ${label}`, input));
        }
        const run = button({ label: 'Run on GitHub', variant: 'primary', onClick: async () => {
          if (!active() || run.disabled) return;
          for (const input of [ref, ...inputs.values()]) {
            if (!input.reportValidity()) { status.textContent = 'Complete the required inputs.'; return; }
          }
          const values = Object.fromEntries([...inputs].map(([name, input]) => [name, input.value]));
          run.disabled = true;
          ref.disabled = true;
          inputs.forEach(input => { input.disabled = true; });
          status.textContent = 'Starting workflow…';
          const response = await actionApi('workflowDispatch', {
            cwd: options.cwd, id: workflow.id, path: workflow.path, ref: selectedRef, inputs: values,
          });
          if (!active()) return;
          status.textContent = response.ok
            ? response.note || 'Dispatch accepted. Open Actions → Runs to follow progress.'
            : response.error || 'Could not start workflow.';
          ref.disabled = false;
          inputs.forEach(input => { input.disabled = false; });
          // Keep accepted requests disabled until the user changes the ref or reopens the form.
          run.disabled = response.ok;
          if (response.ok) options.onAccepted?.();
        } });
        controls.append(run);
        options.onWorkflowLoaded?.(workflow, controls);
      } catch (error) {
        if (active()) status.textContent = error instanceof Error ? error.message : String(error);
      }
    };
    ref.addEventListener('change', () => void load());
    await load();
  } catch (error) {
    if (valid()) status.textContent = error instanceof Error ? error.message : String(error);
  }
}
