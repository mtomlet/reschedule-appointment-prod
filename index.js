/**
 * Reschedule Appointment - PRODUCTION (Phoenix Encanto)
 *
 * Railway-deployable endpoint for Retell AI
 * Reschedules customer appointments to new time
 *
 * PRODUCTION CREDENTIALS - DO NOT USE FOR TESTING
 * Location: Keep It Cut - Phoenix Encanto (201664)
 */

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// PRODUCTION Meevo API Configuration
const CONFIG = {
  AUTH_URL: 'https://marketplace.meevo.com/oauth2/token',
  API_URL: 'https://na1pub.meevo.com/publicapi/v1',
  CLIENT_ID: 'f6a5046d-208e-4829-9941-034ebdd2aa65',
  CLIENT_SECRET: '2f8feb2e-51f5-40a3-83af-3d4a6a454abe',
  TENANT_ID: '200507',
  LOCATION_ID: '201664'  // Phoenix Encanto
};

let token = null;
let tokenExpiry = null;

function normalizePhone(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    cleaned = cleaned.substring(1);
  }
  return cleaned;
}

async function getToken() {
  if (token && tokenExpiry && Date.now() < tokenExpiry - 300000) return token;

  const res = await axios.post(CONFIG.AUTH_URL, {
    client_id: CONFIG.CLIENT_ID,
    client_secret: CONFIG.CLIENT_SECRET
  });

  token = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in * 1000);
  return token;
}

app.post('/reschedule', async (req, res) => {
  try {
    const { phone, new_datetime, appointment_service_id, service_id, client_id, stylist, concurrency_check } = req.body;

    if (!new_datetime) {
      return res.json({
        success: false,
        error: 'Please provide new_datetime for rescheduled appointment'
      });
    }

    if (!appointment_service_id && !phone) {
      return res.json({
        success: false,
        error: 'Please provide appointment_service_id or phone to lookup'
      });
    }

    const authToken = await getToken();

    let serviceIdToReschedule = appointment_service_id;
    let serviceId = service_id;
    let clientId = client_id;
    let stylistId = stylist;
    let concurrencyDigits = concurrency_check;
    let originalStartTime = null;

    // If phone provided, lookup the appointment with pagination
    if (!serviceIdToReschedule) {
      const cleanPhone = normalizePhone(phone);
      let foundClientId = null;

      // Parallel pagination - search 10 pages at a time
      const PAGES_PER_BATCH = 10;
      const ITEMS_PER_PAGE = 100;
      const MAX_BATCHES = 20;  // Search up to 20,000 clients

      for (let batch = 0; batch < MAX_BATCHES && !foundClientId; batch++) {
        const startPage = batch * PAGES_PER_BATCH + 1;
        const pagePromises = [];

        for (let i = 0; i < PAGES_PER_BATCH; i++) {
          const page = startPage + i;
          pagePromises.push(
            axios.get(
              `${CONFIG.API_URL}/clients?tenantid=${CONFIG.TENANT_ID}&locationid=${CONFIG.LOCATION_ID}&PageNumber=${page}&ItemsPerPage=${ITEMS_PER_PAGE}`,
              { headers: { Authorization: `Bearer ${authToken}` } }
            ).catch(() => ({ data: { data: [] } }))
          );
        }

        const results = await Promise.all(pagePromises);
        let emptyPages = 0;

        for (const result of results) {
          const clients = result.data?.data || [];
          if (clients.length === 0) emptyPages++;

          for (const c of clients) {
            const clientPhone = normalizePhone(c.primaryPhoneNumber);
            if (clientPhone === cleanPhone) {
              foundClientId = c.clientId;
              console.log('PRODUCTION: Found client by phone:', c.firstName, c.lastName);
              break;
            }
          }
          if (foundClientId) break;
        }

        if (emptyPages === PAGES_PER_BATCH) break;
      }

      if (!foundClientId) {
        return res.json({
          success: false,
          error: 'No client found with that phone number'
        });
      }

      clientId = foundClientId;

      const appointmentsRes = await axios.get(
        `${CONFIG.API_URL}/book/client/${clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
        { headers: { Authorization: `Bearer ${authToken}` }}
      );

      const allAppointments = appointmentsRes.data.data || appointmentsRes.data;
      const now = new Date();
      const upcomingAppointments = allAppointments
        .filter(apt => new Date(apt.startTime) > now && !apt.isCancelled)
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

      if (upcomingAppointments.length === 0) {
        return res.json({
          success: false,
          error: 'No upcoming appointments found'
        });
      }

      const nextAppt = upcomingAppointments[0];
      serviceIdToReschedule = nextAppt.appointmentServiceId;
      serviceId = nextAppt.serviceId;
      stylistId = stylist || nextAppt.employeeId;
      concurrencyDigits = nextAppt.concurrencyCheckDigits;
      originalStartTime = nextAppt.startTime;

      console.log('PRODUCTION: Found appointment to reschedule:', serviceIdToReschedule, 'from', nextAppt.startTime, 'to', new_datetime);
    }

    // Try PUT first (works for same-day time changes)
    const rescheduleData = new URLSearchParams({
      ServiceId: serviceId,
      StartTime: new_datetime,
      ClientId: clientId,
      ClientGender: 2035,
      ConcurrencyCheckDigits: concurrencyDigits
    });
    if (stylistId) rescheduleData.append('EmployeeId', stylistId);

    let newAppointmentServiceId = serviceIdToReschedule;

    try {
      const rescheduleRes = await axios.put(
        `${CONFIG.API_URL}/book/service/${serviceIdToReschedule}?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
        rescheduleData.toString(),
        {
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );
      console.log('PRODUCTION Reschedule via PUT:', rescheduleRes.data);
    } catch (putError) {
      const errorMsg = putError.response?.data?.error?.message || '';

      // If date change blocked, use cancel+rebook (Meevo API limitation)
      if (errorMsg.includes('When changing the date')) {
        console.log('PRODUCTION: Date change detected, using cancel+rebook');

        // Cancel existing
        await axios.delete(
          `${CONFIG.API_URL}/book/service/${serviceIdToReschedule}?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}&ConcurrencyCheckDigits=${concurrencyDigits}`,
          { headers: { Authorization: `Bearer ${authToken}` } }
        );

        // Book new
        const bookData = new URLSearchParams({
          ServiceId: serviceId,
          ClientId: clientId,
          ClientGender: 2035,
          StartTime: new_datetime
        });
        if (stylistId) bookData.append('EmployeeId', stylistId);

        try {
          const bookRes = await axios.post(
            `${CONFIG.API_URL}/book/service?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
            bookData.toString(),
            {
              headers: {
                Authorization: `Bearer ${authToken}`,
                'Content-Type': 'application/x-www-form-urlencoded'
              }
            }
          );
          newAppointmentServiceId = bookRes.data?.data?.appointmentServiceId || serviceIdToReschedule;
          console.log('PRODUCTION: Rebooked at new time:', new_datetime);
        } catch (bookError) {
          // Rollback - rebook at original time
          console.error('PRODUCTION: Rebook failed, rolling back');
          const rollbackData = new URLSearchParams({
            ServiceId: serviceId,
            ClientId: clientId,
            ClientGender: 2035,
            StartTime: originalStartTime
          });
          if (stylistId) rollbackData.append('EmployeeId', stylistId);
          await axios.post(
            `${CONFIG.API_URL}/book/service?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
            rollbackData.toString(),
            {
              headers: {
                Authorization: `Bearer ${authToken}`,
                'Content-Type': 'application/x-www-form-urlencoded'
              }
            }
          ).catch(() => {});
          throw bookError;
        }
      } else {
        throw putError;
      }
    }

    res.json({
      success: true,
      rescheduled: true,
      new_datetime: new_datetime,
      message: 'Your appointment has been rescheduled',
      appointment_service_id: newAppointmentServiceId
    });

  } catch (error) {
    console.error('PRODUCTION Reschedule error:', error.message);
    res.json({
      success: false,
      error: error.response?.data?.error?.message || error.message
    });
  }
});

app.get('/health', (req, res) => res.json({
  status: 'ok',
  environment: 'PRODUCTION',
  location: 'Phoenix Encanto',
  service: 'Reschedule Appointment'
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PRODUCTION Reschedule server running on port ${PORT}`));
