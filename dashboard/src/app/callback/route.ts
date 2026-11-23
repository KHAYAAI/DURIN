import { handleAuth } from '@workos-inc/authkit-nextjs';

// Completes the AuthKit sign-in (SSO or password) and sets the encrypted session cookie.
export const GET = handleAuth({ returnPathname: '/' });
