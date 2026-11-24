'use client';

import { IntlProvider, type AbstractIntlMessages } from 'use-intl';
import { TIME_ZONE } from '@vitamine/sun';

export function Providers({ locale, messages, children }: { locale: string; messages: AbstractIntlMessages; children: React.ReactNode }) {
  return (
    <IntlProvider locale={locale} messages={messages} timeZone={TIME_ZONE}>
      {children}
    </IntlProvider>
  );
}
