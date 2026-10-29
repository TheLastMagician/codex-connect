const leases=new WeakMap();
export function targetLeases(desktop) {
  if(!leases.has(desktop))leases.set(desktop,new Map());
  return leases.get(desktop);
}
