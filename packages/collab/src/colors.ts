/**
 * Identidad de color de cada colaborador.
 *
 * El color viaja por awareness (es dato de red, no un token de la UI): lo elige
 * cada cliente y los demás lo pintan tal cual en la lista de conectados, en los
 * cursores remotos y en el chat. Se saca del NOMBRE para que la misma persona
 * salga siempre del mismo color… pero todo el mundo entra como "Productor" si
 * no cambia el suyo, y entonces una sala de tres era tres puntos del mismo
 * color.
 *
 * `pickDistinctColor` arregla eso sin protocolo nuevo: quien comparta color con
 * alguien de clientId MÁS BAJO se aparta al primer color libre. El de id más
 * bajo nunca se mueve, así que la cosa converge aunque los tres se miren a la
 * vez, y cada cliente decide por su cuenta con el mismo dato (la presencia).
 */

export const USER_COLORS: readonly string[] = [
  '#5aa9e6', '#e6675a', '#7ce65a', '#e6c95a',
  '#b45ae6', '#5ae6c9', '#e65aa9', '#e6935a',
];

/** Color estable por nombre (el mismo nombre da el mismo color en todas las máquinas). */
export function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return USER_COLORS[h % USER_COLORS.length]!;
}

/**
 * Color que debería llevar `self` para no chocar con nadie de id más bajo.
 * Devuelve el que ya tiene si no hay conflicto. Con más gente que colores
 * repetir es inevitable: entonces reparte por clientId en vez de dejar a todos
 * con el primero de la lista.
 */
export function pickDistinctColor(
  self: { clientId: number; color: string },
  others: readonly { clientId: number; color: string }[],
): string {
  const taken = new Set(
    others.filter((p) => p.clientId < self.clientId).map((p) => p.color),
  );
  if (!taken.has(self.color)) return self.color;
  return (
    USER_COLORS.find((c) => !taken.has(c)) ?? USER_COLORS[self.clientId % USER_COLORS.length]!
  );
}
