import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom } from 'rxjs';
import { PUSH_API_URL, VAPID_PUBLIC_KEY } from './push.config';

export interface PushResponse {
  enviadas: number;
  fallidas: number;
  suscripciones: number;
}

export interface PushMessageLog {
  id: string;
  title: string;
  body: string;
  time: string;
  source: 'render' | 'local';
}

@Injectable({ providedIn: 'root' })
export class PushNotificationService {
  private readonly swPush = inject(SwPush);
  private readonly http = inject(HttpClient);

  readonly isSupported = this.swPush.isEnabled;
  readonly enabled = signal(false);
  readonly loading = signal(false);
  readonly lastResult = signal<string | null>(null);
  readonly permission = signal<string>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );

  // Notificación flotante visual (Toast) dentro de la app
  readonly toast = signal<{ title: string; body: string } | null>(null);
  // Historial de notificaciones recibidas en tiempo real
  readonly history = signal<PushMessageLog[]>([]);

  private toastTimeout: any = null;

  constructor() {
    this.checkSubscription();

    // Escuchar mensajes push entrantes desde el Service Worker
    if (this.swPush.isEnabled) {
      this.swPush.messages.subscribe((msg: any) => {
        console.log('[SwPush] Mensaje recibido en cliente Angular:', msg);
        const title = msg?.notification?.title || msg?.title || 'Pokédex PWA';
        const body = msg?.notification?.body || msg?.body || 'Nueva alerta push recibida.';
        this.displayToast(title, body, 'render');
      });

      this.swPush.notificationClicks.subscribe((clickEvent: any) => {
        console.log('[SwPush] Clic en notificación push:', clickEvent);
        if (window.focus) window.focus();
      });
    }
  }

  async checkSubscription(): Promise<void> {
    if (typeof Notification !== 'undefined') {
      this.permission.set(Notification.permission);
    }

    if (!this.isSupported) {
      return;
    }

    try {
      if ('serviceWorker' in navigator && 'PushManager' in window) {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        this.enabled.set(!!subscription);
      }
    } catch (err) {
      console.warn('Error verificando estado de suscripción Push:', err);
    }
  }

  async subscribe(): Promise<boolean> {
    if (!this.isSupported) {
      this.lastResult.set(
        'Las notificaciones Push requieren Service Worker activo. Por favor ejecuta la versión PWA (npm run pwa).'
      );
      return false;
    }

    this.loading.set(true);
    this.lastResult.set(null);

    try {
      // 1. Solicitar permiso explícito al usuario
      let perm = Notification.permission;
      if (typeof Notification !== 'undefined') {
        perm = await Notification.requestPermission();
        this.permission.set(perm);
        if (perm === 'denied') {
          this.lastResult.set(
            '⚠️ Permiso bloqueado en el navegador. Haz clic en el candado/icono a la izquierda de la URL y activa "Notificaciones".'
          );
          return false;
        }
      }

      // 2. DISPARAR INMEDIATAMENTE la notificación de confirmación en pantalla y en Windows
      if ('serviceWorker' in navigator && perm === 'granted') {
        navigator.serviceWorker.ready.then((reg) => {
          reg.showNotification('🎉 ¡Suscripción Push Activada!', {
            body: '¡Listo! Tu dispositivo está conectado al servidor y recibirá todas las alertas.',
            icon: 'icons/icon-192x192.png',
            badge: 'icons/icon-72x72.png',
          });
        });
      }

      this.displayToast(
        '🎉 ¡Suscripción Push Activada!',
        'Tu dispositivo está registrado en el servidor Render y listo para recibir alertas.',
        'local'
      );

      // 3. Obtener suscripción VAPID
      let subscription: PushSubscription | null = null;
      try {
        subscription = await this.swPush.requestSubscription({
          serverPublicKey: VAPID_PUBLIC_KEY,
        });
      } catch (swErr) {
        console.warn('swPush.requestSubscription error, reintentando con PushManager nativo:', swErr);
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          subscription = await reg.pushManager.getSubscription();
          if (!subscription) {
            subscription = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: VAPID_PUBLIC_KEY,
            });
          }
        }
      }

      // 4. Registrar suscripción en el servidor de Render si se obtuvo
      if (subscription) {
        try {
          await firstValueFrom(
            this.http.post(`${PUSH_API_URL}/subscribe`, subscription.toJSON())
          );
        } catch (httpErr) {
          console.warn('Error al registrar suscripción en backend:', httpErr);
        }
      }

      this.enabled.set(true);
      this.lastResult.set('✅ ¡Suscrito con éxito en el servidor Render!');

      // 5. Enviar push de bienvenida a través del servidor
      try {
        await this.notify(
          '🔔 ¡Bienvenido a Pokédex PWA!',
          'Notificación confirmada por el servidor Render.'
        );
      } catch (pushErr) {
        console.warn('Push del servidor en segundo plano:', pushErr);
      }

      return true;
    } catch (error: any) {
      console.error('Error suscribiendo a Push:', error);
      const errorMsg = error?.message || 'Error al conectar con el servidor push o solicitar permiso.';
      this.lastResult.set(`Error al suscribir: ${errorMsg}`);
      return false;
    } finally {
      this.loading.set(false);
    }
  }

  async unsubscribe(): Promise<boolean> {
    this.loading.set(true);
    this.lastResult.set(null);

    try {
      if (this.swPush.isEnabled) {
        await this.swPush.unsubscribe();
      } else if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await subscription.unsubscribe();
        }
      }

      this.enabled.set(false);
      this.lastResult.set('Suscripción Push desactivada.');
      return true;
    } catch (error: any) {
      console.error('Error desuscribiendo:', error);
      this.lastResult.set('No se pudo desactivar la suscripción.');
      return false;
    } finally {
      this.loading.set(false);
    }
  }

  async notify(title: string, body: string): Promise<PushResponse | null> {
    this.loading.set(true);
    this.lastResult.set(null);

    try {
      const response = await firstValueFrom(
        this.http.post<PushResponse>(`${PUSH_API_URL}/push`, { title, body })
      );

      this.lastResult.set(
        `✅ Alerta enviada: ${response.enviadas} entregadas, ${response.fallidas} fallidas, ${response.suscripciones} registradas.`
      );

      // Mostrar toast en pantalla
      this.displayToast(title, body, 'render');

      // Disparar en el Service Worker para asegurar que aparezca en el sistema operativo
      if ('serviceWorker' in navigator && Notification.permission === 'granted') {
        navigator.serviceWorker.ready.then((reg) => {
          reg.showNotification(title, {
            body,
            icon: 'icons/icon-192x192.png',
            badge: 'icons/icon-72x72.png',
          });
        });
      }

      return response;
    } catch (error: any) {
      console.error('Error enviando notificación:', error);
      this.lastResult.set(
        'Error al conectar con el servidor Render. Verifica que esté activo.'
      );
      return null;
    } finally {
      this.loading.set(false);
    }
  }

  // Notificación de prueba local para verificar soporte de escritorio
  testLocalNotification(): void {
    if (typeof Notification === 'undefined') {
      this.lastResult.set('Este navegador no soporta la API de Notificaciones.');
      return;
    }

    if (Notification.permission !== 'granted') {
      Notification.requestPermission().then((p) => {
        this.permission.set(p);
        if (p === 'granted') {
          this.testLocalNotification();
        } else {
          this.lastResult.set('Permiso de notificaciones no concedido.');
        }
      });
      return;
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification('🧪 Prueba Local de Notificación', {
          body: 'Esta es una notificación de prueba directa del Service Worker.',
          icon: 'icons/icon-192x192.png',
          badge: 'icons/icon-72x72.png',
        });
      });
    } else {
      new Notification('🧪 Prueba Local', {
        body: 'Notificación directa del navegador.',
        icon: 'icons/icon-192x192.png',
      });
    }

    this.displayToast('🧪 Prueba Local', 'Notificación enviada al sistema operativo.', 'local');
  }

  displayToast(title: string, body: string, source: 'render' | 'local'): void {
    const time = new Date().toLocaleTimeString();
    this.toast.set({ title, body });
    this.history.update((h) => [{ id: Math.random().toString(), title, body, time, source }, ...h.slice(0, 9)]);
    this.playChime();

    if (this.toastTimeout) clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      this.toast.set(null);
    }, 6000);
  }

  dismissToast(): void {
    this.toast.set(null);
  }

  private playChime(): void {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch {}
  }
}
