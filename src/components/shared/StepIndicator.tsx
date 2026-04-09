interface Step {
  label: string;
  done: boolean;
  active: boolean;
}

export function StepIndicator({ steps }: { steps: Step[] }) {
  return (
    <div className="flex items-center gap-2 mb-6">
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium border ${
              step.done
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : step.active
                  ? 'border-indigo-400 text-indigo-400'
                  : 'border-gray-600 text-gray-500'
            }`}
          >
            {step.done ? '\u2713' : i + 1}
          </div>
          <span
            className={`text-sm ${
              step.done
                ? 'text-gray-300'
                : step.active
                  ? 'text-indigo-300'
                  : 'text-gray-500'
            }`}
          >
            {step.label}
          </span>
          {i < steps.length - 1 && (
            <div className={`w-8 h-px ${step.done ? 'bg-indigo-500' : 'bg-gray-700'}`} />
          )}
        </div>
      ))}
    </div>
  );
}
