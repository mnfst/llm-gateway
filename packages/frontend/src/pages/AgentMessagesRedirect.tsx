import { Navigate, useLocation, useParams } from '@solidjs/router';
import type { Component } from 'solid-js';

/**
 * Redirects /harnesses/:agentName/messages → /messages?agent=<name> so the
 * global message log opens pre-filtered to the harness the user came from
 * (e.g. via a Recent Requests "View more" link). Extra query params (like the
 * `?request=` drawer deep-link) are carried through.
 */
const AgentMessagesRedirect: Component = () => {
  const params = useParams<{ agentName: string }>();
  const location = useLocation();
  const target = () => {
    const search = new URLSearchParams(location.search);
    search.set('agent', decodeURIComponent(params.agentName));
    return `/messages?${search.toString()}`;
  };
  return <Navigate href={target()} />;
};

export default AgentMessagesRedirect;
