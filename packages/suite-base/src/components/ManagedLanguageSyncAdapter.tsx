// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import { useAppConfigurationValue } from "@lichtblick/suite-base/hooks/useAppConfigurationValue";
import { reportError } from "@lichtblick/suite-base/reportError";

export function ManagedLanguageSyncAdapter(): React.JSX.Element {
  const [language] = useAppConfigurationValue<string>(AppSetting.LANGUAGE);
  const { i18n } = useTranslation();
  useEffect(() => {
    if (language == undefined || i18n.language === language) {
      return;
    }
    void i18n.changeLanguage(language).catch((error: unknown) => {
      reportError(error as Error);
    });
  }, [language, i18n]);
  return <></>;
}
