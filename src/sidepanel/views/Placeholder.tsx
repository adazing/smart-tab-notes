/**
 * Stand-in for a view that has not been built yet. Says what will live
 * here so the shell reads as unfinished rather than broken.
 */

interface PlaceholderProps {
  title: string;
  children: React.ReactNode;
}

export function Placeholder({ title, children }: PlaceholderProps): JSX.Element {
  return (
    <section className="placeholder">
      <h2 className="placeholder__title">{title}</h2>
      <p className="placeholder__body">{children}</p>
    </section>
  );
}
