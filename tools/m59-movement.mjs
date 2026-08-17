// Movement results that cannot become legal by retrying another heading or pretending
// a square is occupied. These are failures of the local collision contract or of the
// state needed to apply it; callers must propagate them before any further packet.
export const TERMINAL_MOVEMENT_REASONS = Object.freeze([
  'collision_geometry_unavailable',
  'collision_geometry_changed',
  'room_security_unknown',
  'room_geometry_mismatch',
  'room_changed_before_move',
  'position_confirmation_timeout',
  'own_position_unknown',
  'start_has_no_floor',
  'invalid_move_target',
]);

const TERMINAL = new Set(TERMINAL_MOVEMENT_REASONS);

export function isTerminalMovementReason(reason) {
  return typeof reason === 'string' && TERMINAL.has(reason);
}

export function terminalMovementResult(result) {
  return result && isTerminalMovementReason(result.reason) ? result : null;
}
