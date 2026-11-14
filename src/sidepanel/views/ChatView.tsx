import { Placeholder } from './Placeholder';

/**
 * Long-running chat with access to the tabs the user has confirmed.
 * Built by the chat ticket.
 */
export function ChatView(): JSX.Element {
  return (
    <Placeholder title="Chat">
      The chat panel goes here: a conversation that can draw on the current tab
      plus the other tabs the user confirms, with citations back to each tab.
    </Placeholder>
  );
}
