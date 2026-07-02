import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { createApiClient } from '@ffc/api-client';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';

type ApiState = 'checking' | 'ok' | 'unreachable';

export default function HomeScreen() {
  const { t, i18n } = useTranslation();
  const [apiState, setApiState] = useState<ApiState>('checking');

  useEffect(() => {
    const client = createApiClient({ baseUrl: API_URL });
    client
      .GET('/v1/health')
      .then(({ data }) => setApiState(data?.status === 'ok' ? 'ok' : 'unreachable'))
      .catch(() => setApiState('unreachable'));
  }, []);

  const nextLanguage = i18n.language === 'fr' ? 'en' : 'fr';

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t('mobile.welcome')}</Text>
      <Text style={styles.tagline}>{t('mobile.tagline')}</Text>

      <Text style={[styles.apiStatus, apiState === 'unreachable' && styles.apiError]}>
        {apiState === 'checking' && t('mobile.apiChecking')}
        {apiState === 'ok' && t('mobile.apiOk')}
        {apiState === 'unreachable' && t('mobile.apiUnreachable')}
      </Text>

      <Pressable style={styles.button} onPress={() => void i18n.changeLanguage(nextLanguage)}>
        <Text style={styles.buttonLabel}>{t('mobile.changeLanguage')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
    backgroundColor: '#f7f8f9',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
    color: '#17242d',
  },
  tagline: {
    fontSize: 16,
    textAlign: 'center',
    color: '#42525c',
  },
  apiStatus: {
    marginTop: 12,
    fontSize: 14,
    color: '#1a7f37',
  },
  apiError: {
    color: '#b42318',
  },
  button: {
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: '#1668a5',
  },
  buttonLabel: {
    color: '#ffffff',
    fontWeight: '600',
  },
});
