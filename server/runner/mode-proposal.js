const SITUATIONS = ['implement_in_wrong_mode', 'plan_in_build'];

/** Shared preset used by the renderer modal and durable server requests. */
export function buildProposeModeSwitchQuestions(situation) {
  if (situation === 'implement_in_wrong_mode') return {
    title: 'Switch mode?', questions: [{ id: 'mode_switch',
      prompt: 'Implementation needs Build mode. How do you want to proceed?', options: [
        { id: 'build', label: 'Switch to Build', description: 'Change this chat to Build mode.' },
        { id: 'stay', label: 'Stay in current mode', description: 'Continue without switching (limited tools).' },
      ] }],
  };
  if (situation === 'plan_in_build') return {
    title: 'Switch mode?', questions: [{ id: 'mode_switch',
      prompt: 'Planning works best in Plan mode. Switch?', options: [
        { id: 'plan', label: 'Switch to Plan', description: 'Change this chat to Plan mode.' },
        { id: 'stay_build', label: 'Stay in Build', description: 'Keep planning informally in Build.' },
      ] }],
  };
  throw new Error(`Unknown handoff situation: ${String(situation)}`);
}

export function validateProposeModeSwitchArgs(args) {
  const situation = typeof args.situation === 'string' ? args.situation.trim() : '';
  if (!SITUATIONS.includes(situation)) return { ok: false, error: `Error: situation must be one of: ${SITUATIONS.join(', ')}` };
  return { ok: true, args: buildProposeModeSwitchQuestions(situation) };
}
