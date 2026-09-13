import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [, setVersion] = useState(0);

  useEffect(() => {
    const stream = stdout ?? process.stdout;
    if (!stream) return;

    const onResize = () => {
      setVersion((v) => v + 1);
    };

    stream.on('resize', onResize);
    process.stdout?.on('resize', onResize);
    process.on('SIGWINCH', onResize);

    return () => {
      stream.off('resize', onResize);
      process.stdout?.off('resize', onResize);
      process.off('SIGWINCH', onResize);
    };
  }, [stdout]);

  const stream = stdout ?? process.stdout;
  const columns = stream?.columns || process.stdout?.columns || 80;
  const rows = stream?.rows || process.stdout?.rows || 24;

  return { columns, rows };
}
