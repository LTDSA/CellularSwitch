export function ModuleComputerIllustration({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 200 160"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Laptop base */}
      <rect x="40" y="80" width="120" height="70" rx="6" fill="#e5e7eb" stroke="#9ca3af" strokeWidth="2" />
      <rect x="48" y="88" width="104" height="54" rx="2" fill="#f9fafb" />
      {/* USB cable */}
      <path d="M160 115 L180 115" stroke="#9ca3af" strokeWidth="3" />
      <path d="M180 115 L180 70" stroke="#9ca3af" strokeWidth="3" />
      {/* Module */}
      <rect x="160" y="40" width="40" height="40" rx="4" fill="#d1d5db" stroke="#6b7280" strokeWidth="2" />
      <rect x="168" y="48" width="24" height="4" rx="1" fill="#9ca3af" />
      <rect x="168" y="56" width="16" height="4" rx="1" fill="#9ca3af" />
      <rect x="168" y="64" width="20" height="4" rx="1" fill="#9ca3af" />
      {/* LED */}
      <circle cx="188" cy="76" r="2" fill="#22c55e" />
    </svg>
  )
}
