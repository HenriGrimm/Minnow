const SECTIONS = [
  'Goal and scope',
  'Decisions and constraints',
  'Relevant files',
  'Implementation steps',
  'Acceptance checklist',
  'Risks and open questions',
];

/** Validate sequential build instructions without imposing a board task graph. */
export function validateBuildPlan(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const errors = [];
  const addError = (line, message, hint) => errors.push({ line, column: 1, message, hint });
  let fence = null;
  const visible = lines.map((line) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker && !fence) {
      fence = marker[1];
      return '';
    }
    if (fence) {
      if (line.trim().match(new RegExp(`^${fence[0]}{${fence.length},}\\s*$`))) fence = null;
      return '';
    }
    return line;
  });
  const headings = visible.flatMap((line, index) =>
    /^## /.test(line) ? [{ title: line.slice(3).trim(), index }] : [],
  );
  const sections = new Map();
  for (const title of SECTIONS) {
    const matches = headings.filter((heading) => heading.title === title);
    if (matches.length !== 1) {
      addError(1, `Expected one "## ${title}" section.`, 'Use the Build plan template.');
      continue;
    }
    const start = matches[0].index;
    const end = headings.find((heading) => heading.index > start)?.index ?? lines.length;
    const body = visible.slice(start + 1, end).join('\n').trim();
    sections.set(title, { start, end, body });
    if (!body) {
      addError(start + 1, `Empty ${title} section.`, 'Describe the requirement, or state None if not applicable.');
    }
  }
  const implementation = sections.get('Implementation steps');
  let stepCount = 0;
  if (implementation) {
    const steps = visible.flatMap((line, index) => {
      const match = line.match(/^### (\d+)\.\s+\S/);
      return match && index > implementation.start && index < implementation.end ? [{ index, number: Number(match[1]) }] : [];
    });
    stepCount = steps.length;
    if (!stepCount) {
      addError(implementation.start + 1, 'No implementation steps.', 'Add numbered headings beginning with ### 1.');
    }
    steps.forEach((step, index) => {
      const body = visible.slice(step.index + 1, steps[index + 1]?.index ?? implementation.end).join('\n');
      if (step.number !== index + 1) {
        addError(step.index + 1, 'Steps must be numbered in execution order starting at 1.', 'Renumber the steps sequentially.');
      }
      for (const field of ['Changes', 'Verify']) {
        if (!new RegExp(`^- (?:\\*\\*${field}:\\*\\*|${field}:)[ \\t]+\\S`, 'm').test(body)) {
          addError(step.index + 1, `Step ${step.number} needs ${field}.`, `Add - ${field}: with concrete instructions.`);
        }
      }
      if (!/^- \[[ xX]\] \S/m.test(body)) {
        addError(step.index + 1, `Step ${step.number} needs a progress checkbox.`, 'Add - [ ] followed by the step outcome.');
      }
    });
  }
  const acceptance = sections.get('Acceptance checklist');
  if (acceptance && !/^- \[[ xX]\] \S/m.test(acceptance.body)) {
    addError(acceptance.start + 1, 'Missing acceptance checklist.', 'Add - [ ] followed by an observable outcome.');
  }
  return { errors, stepCount };
}
