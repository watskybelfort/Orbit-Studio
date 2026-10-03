import { createContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkspaceSize } from './window-bounds';

export const WorkspaceAreaContext = createContext<WorkspaceSize | null>(null);

/** Un observador del área útil para todas las ventanas, incluidas escalas UI. */
export function WorkspaceArea({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<WorkspaceSize | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const w = element.clientWidth;
      const h = element.clientHeight;
      setSize((previous) => previous?.w === w && previous.h === h ? previous : { w, h });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="workspace" ref={ref}>
      <WorkspaceAreaContext.Provider value={size}>{children}</WorkspaceAreaContext.Provider>
    </div>
  );
}
