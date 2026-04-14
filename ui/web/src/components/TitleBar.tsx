interface TitleBarProps {
  mode: string;
  wizardStep?: { current: number; total: number; name: string };
}

export function TitleBar({ mode, wizardStep }: TitleBarProps) {
  const center = wizardStep
    ? `Setup: Step ${wizardStep.current}/${wizardStep.total} ${wizardStep.name}`
    : "";

  return (
    <header className="chrome-bar chrome-bar--title">
      <span className="chrome-bar__left"> rollio</span>
      <span className="chrome-bar__center">{center}</span>
      <span className="chrome-bar__right"> {mode} </span>
    </header>
  );
}
