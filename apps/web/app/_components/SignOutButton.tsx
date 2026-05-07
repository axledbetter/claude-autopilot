'use client';

export default function SignOutButton() {
  const onClick = async () => {
    await fetch('/api/auth/sign-out', { method: 'POST' });
    window.location.assign('/');
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-4 py-2 rounded-md border border-white/20 hover:bg-white/10 transition"
    >
      Sign out
    </button>
  );
}
