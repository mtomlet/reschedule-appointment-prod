/**
 * Reschedule Appointment - PRODUCTION (Phoenix Encanto)
 *
 * Railway-deployable endpoint for Retell AI
 * Reschedules customer appointments to new time
 *
 * PRODUCTION CREDENTIALS - DO NOT USE FOR TESTING
 * Location: Keep It Cut - Phoenix Encanto (201664)
 *
 * UPDATED: Now includes linked profile appointments (minors/guests)
 * UPDATED: Now preserves add-on services when rescheduling
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

/**
 * Find an available stylist for a specific time slot and service
 * Uses the V2 scan/openings API which requires POST
 */
async function findAvailableStylist(authToken, serviceId, dateTime) {
  try {
    const date = dateTime.split('T')[0];
    const timePart = dateTime.split('T')[1].substring(0, 5); // e.g., "16:10"

    // Extract time for the scan window (e.g., "16:10" -> window "16:00" to "18:00")
    const hours = parseInt(timePart.split(':')[0], 10);
    const startHour = Math.floor(hours / 2) * 2; // Round down to even hour
    const startTime = String(startHour).padStart(2, '0') + ':00';
    const endTime = String(startHour + 2).padStart(2, '0') + ':00';

    console.log(`PRODUCTION: Scanning for availability on ${date} from ${startTime} to ${endTime}`);

    // Get all active employees first
    const empRes = await axios.get(
      `${CONFIG.API_URL}/employees?tenantid=${CONFIG.TENANT_ID}&locationid=${CONFIG.LOCATION_ID}&ItemsPerPage=100`,
      { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
    );
    const employees = (empRes.data?.data || [])
      .filter(emp => emp.objectState === 2026)
      .filter(emp => !['home', 'training', 'test'].includes((emp.firstName || '').toLowerCase()));

    console.log(`PRODUCTION: Checking ${employees.length} employees for availability at ${dateTime}`);

    // Scan each employee for openings
    for (const emp of employees) {
      const scanRequest = {
        LocationId: parseInt(CONFIG.LOCATION_ID),
        TenantId: parseInt(CONFIG.TENANT_ID),
        ScanDateType: 1,
        StartDate: date,
        EndDate: date,
        ScanTimeType: 1,
        StartTime: startTime,
        EndTime: endTime,
        ScanServices: [{ ServiceId: serviceId, EmployeeIds: [emp.id] }]
      };

      try {
        const openingsRes = await axios.post(
          `https://na1pub.meevo.com/publicapi/v2/scan/openings?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
          scanRequest,
          { headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' }, timeout: 5000 }
        );

        const rawData = openingsRes.data?.data || [];
        for (const item of rawData) {
          for (const slot of (item.serviceOpenings || [])) {
            // Extract just time portion (HH:MM) for comparison since API returns no timezone
            const targetTimeStr = dateTime.split('T')[1].substring(0, 5); // e.g., "16:10"
            const slotTimeStr = slot.startTime.split('T')[1].substring(0, 5); // e.g., "16:10"
            if (targetTimeStr === slotTimeStr) {
              console.log(`PRODUCTION: Found available stylist ${emp.id} (${emp.firstName}) at ${slot.startTime}`);
              return emp.id;
            }
          }
        }
      } catch (scanErr) {
        // This employee might not be scheduled, continue to next
        continue;
      }
    }

    console.log(`PRODUCTION: No available stylist found for ${dateTime}`);
    return null;
  } catch (err) {
    console.log(`PRODUCTION: Error finding available stylist:`, err.message);
    return null;
  }
}

/**
 * Find linked profiles (minors/guests) for a guardian
 */
async function findLinkedProfiles(authToken, guardianId, locationId) {
  const linkedProfiles = [];
  const seenIds = new Set();

  console.log(`PRODUCTION: Finding linked profiles for guardian: ${guardianId}`);

  const PAGE_RANGES = [
    { start: 150, end: 200 },
    { start: 100, end: 150 },
    { start: 50, end: 100 },
    { start: 1, end: 50 }
  ];

  for (const range of PAGE_RANGES) {
    for (let batchStart = range.start; batchStart < range.end; batchStart += 10) {
      const pagePromises = [];

      for (let page = batchStart; page < batchStart + 10 && page <= range.end; page++) {
        pagePromises.push(
          axios.get(
            `${CONFIG.API_URL}/clients?tenantid=${CONFIG.TENANT_ID}&locationid=${locationId}&PageNumber=${page}&ItemsPerPage=100`,
            { headers: { Authorization: `Bearer ${authToken}` }, timeout: 3000 }
          ).catch(() => ({ data: { data: [] } }))
        );
      }

      const results = await Promise.all(pagePromises);
      let emptyPages = 0;
      const candidateClients = [];

      for (const result of results) {
        const clients = result.data?.data || [];
        if (clients.length === 0) {
          emptyPages++;
          continue;
        }

        for (const c of clients) {
          if (seenIds.has(c.clientId)) continue;
          if (!c.primaryPhoneNumber) {
            candidateClients.push(c);
          }
        }
      }

      for (let i = 0; i < candidateClients.length; i += 50) {
        const batch = candidateClients.slice(i, i + 50);
        const detailPromises = batch.map(c =>
          axios.get(
            `${CONFIG.API_URL}/client/${c.clientId}?TenantId=${CONFIG.TENANT_ID}&LocationId=${locationId}`,
            { headers: { Authorization: `Bearer ${authToken}` }, timeout: 2000 }
          ).catch(() => null)
        );

        const detailResults = await Promise.all(detailPromises);

        for (const detailRes of detailResults) {
          if (!detailRes) continue;
          const client = detailRes.data?.data || detailRes.data;
          if (!client || seenIds.has(client.clientId)) continue;

          seenIds.add(client.clientId);

          if (client.guardianId === guardianId) {
            linkedProfiles.push({
              client_id: client.clientId,
              first_name: client.firstName,
              last_name: client.lastName,
              name: `${client.firstName} ${client.lastName}`
            });
            console.log(`PRODUCTION: Found linked profile: ${client.firstName} ${client.lastName}`);
          }
        }
      }

      if (emptyPages >= 10) break;
    }

    if (linkedProfiles.length > 0) break;
  }

  return linkedProfiles;
}

/**
 * Get ALL services for a given appointmentId (main service + add-ons)
 * Returns services sorted by start time (main service first)
 */
async function getAllServicesForAppointment(authToken, clientId, appointmentId, locationId) {
  try {
    const apptRes = await axios.get(
      `${CONFIG.API_URL}/book/client/${clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${locationId}`,
      { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
    );

    const allServices = apptRes.data?.data || apptRes.data || [];

    // Filter to only services in THIS appointment (same appointmentId)
    const appointmentServices = allServices
      .filter(s => s.appointmentId === appointmentId && !s.isCancelled)
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    return appointmentServices.map(s => ({
      appointment_service_id: s.appointmentServiceId,
      appointment_id: s.appointmentId,
      service_id: s.serviceId,
      start_time: s.startTime,
      end_time: s.servicingEndTime,
      stylist_id: s.employeeId,
      concurrency_check: s.concurrencyCheckDigits,
      client_id: clientId
    }));
  } catch (error) {
    console.log('Error getting appointment services:', error.message);
    return [];
  }
}

/**
 * Get appointments for a specific client
 */
async function getClientAppointments(authToken, clientId, clientName, locationId) {
  try {
    const appointmentsRes = await axios.get(
      `${CONFIG.API_URL}/book/client/${clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${locationId}`,
      { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
    );

    const allAppointments = appointmentsRes.data?.data || appointmentsRes.data || [];
    const now = new Date();

    return allAppointments
      .filter(apt => new Date(apt.startTime) > now && !apt.isCancelled)
      .map(apt => ({
        appointment_id: apt.appointmentId,
        appointment_service_id: apt.appointmentServiceId,
        datetime: apt.startTime,
        service_id: apt.serviceId,
        stylist_id: apt.employeeId,
        concurrency_check: apt.concurrencyCheckDigits,
        client_id: clientId,
        client_name: clientName
      }));
  } catch (error) {
    console.log(`Error getting appointments for ${clientName}:`, error.message);
    return [];
  }
}

app.post('/reschedule', async (req, res) => {
  try {
    const { phone, new_datetime, appointment_service_id, service_id, client_id, stylist, concurrency_check } = req.body;

    console.log('PRODUCTION Reschedule request:', JSON.stringify(req.body));

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

    // FAST PATH: If appointment_service_id is provided WITH phone, find client first then match appointment
    if (serviceIdToReschedule && phone && (!serviceId || !clientId || !concurrencyDigits)) {
      console.log('PRODUCTION: Using provided appointment_service_id:', serviceIdToReschedule);
      console.log('PRODUCTION: Finding client by phone first (fast path)...');

      const cleanPhone = normalizePhone(phone);
      let foundClient = null;

      // Find client by phone (fast - parallel pagination)
      const PAGES_PER_BATCH = 10;
      const MAX_BATCHES = 20;

      for (let batch = 0; batch < MAX_BATCHES && !foundClient; batch++) {
        const startPage = batch * PAGES_PER_BATCH + 1;
        const pagePromises = [];

        for (let i = 0; i < PAGES_PER_BATCH; i++) {
          const page = startPage + i;
          pagePromises.push(
            axios.get(
              `${CONFIG.API_URL}/clients?tenantid=${CONFIG.TENANT_ID}&locationid=${CONFIG.LOCATION_ID}&PageNumber=${page}&ItemsPerPage=100`,
              { headers: { Authorization: `Bearer ${authToken}` }, timeout: 3000 }
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
              foundClient = c;
              break;
            }
          }
          if (foundClient) break;
        }

        if (emptyPages === PAGES_PER_BATCH) break;
      }

      if (!foundClient) {
        return res.json({
          success: false,
          error: 'No client found with that phone number'
        });
      }

      // First check main client's appointments (fast)
      let found = false;
      console.log('PRODUCTION: Checking main client appointments first');

      try {
        const apptRes = await axios.get(
          `${CONFIG.API_URL}/book/client/${foundClient.clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
          { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
        );
        const appointments = apptRes.data?.data || apptRes.data || [];
        const match = appointments.find(a => a.appointmentServiceId === serviceIdToReschedule);
        if (match) {
          serviceId = serviceId || match.serviceId;
          clientId = clientId || match.clientId || foundClient.clientId;
          stylistId = stylistId || match.employeeId;
          concurrencyDigits = concurrencyDigits || match.concurrencyCheckDigits;
          originalStartTime = match.startTime;
          console.log('PRODUCTION: Found appointment for main client', foundClient.firstName, foundClient.lastName);
          found = true;
        }
      } catch (e) {
        console.log('Error checking main client appointments:', e.message);
      }

      // Only search linked profiles if not found for main client
      if (!found) {
        console.log('PRODUCTION: Not found for main client, checking linked profiles...');
        const linkedProfiles = await findLinkedProfiles(authToken, foundClient.clientId, CONFIG.LOCATION_ID);

        for (const profile of linkedProfiles) {
          try {
            const apptRes = await axios.get(
              `${CONFIG.API_URL}/book/client/${profile.client_id}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
              { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
            );
            const appointments = apptRes.data?.data || apptRes.data || [];
            const match = appointments.find(a => a.appointmentServiceId === serviceIdToReschedule);
            if (match) {
              serviceId = serviceId || match.serviceId;
              clientId = clientId || match.clientId || profile.client_id;
              stylistId = stylistId || match.employeeId;
              concurrencyDigits = concurrencyDigits || match.concurrencyCheckDigits;
              originalStartTime = match.startTime;
              console.log('PRODUCTION: Found appointment for linked profile', profile.first_name, profile.last_name);
              found = true;
              break;
            }
          } catch (e) {
            console.log('Error checking appointments for', profile.first_name, ':', e.message);
          }
        }
      }

      if (!found) {
        return res.json({
          success: false,
          error: 'Could not find appointment with that ID for this caller'
        });
      }
    } else if (!serviceIdToReschedule) {
      // PHONE LOOKUP PATH: If no appointment_service_id, search by phone
      const cleanPhone = normalizePhone(phone);
      let foundClient = null;

      const PAGES_PER_BATCH = 10;
      const ITEMS_PER_PAGE = 100;
      const MAX_BATCHES = 20;

      for (let batch = 0; batch < MAX_BATCHES && !foundClient; batch++) {
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
              foundClient = c;
              console.log('PRODUCTION: Found client by phone:', c.firstName, c.lastName);
              break;
            }
          }
          if (foundClient) break;
        }

        if (emptyPages === PAGES_PER_BATCH) break;
      }

      if (!foundClient) {
        return res.json({
          success: false,
          error: 'No client found with that phone number'
        });
      }

      // Get caller's appointments
      const callerName = `${foundClient.firstName} ${foundClient.lastName}`;
      const callerAppointments = await getClientAppointments(
        authToken,
        foundClient.clientId,
        callerName,
        CONFIG.LOCATION_ID
      );

      // Find linked profiles and their appointments
      const linkedProfiles = await findLinkedProfiles(authToken, foundClient.clientId, CONFIG.LOCATION_ID);
      let linkedAppointments = [];
      for (const profile of linkedProfiles) {
        const profileAppointments = await getClientAppointments(
          authToken,
          profile.client_id,
          profile.name,
          CONFIG.LOCATION_ID
        );
        linkedAppointments = linkedAppointments.concat(profileAppointments);
      }

      // Combine and sort all appointments
      const allAppointments = [...callerAppointments, ...linkedAppointments];
      allAppointments.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

      console.log('PRODUCTION: Total appointments:', callerAppointments.length, '(caller) +', linkedAppointments.length, '(linked) =', allAppointments.length);

      if (allAppointments.length === 0) {
        return res.json({
          success: false,
          error: 'No upcoming appointments found'
        });
      }

      const nextAppt = allAppointments[0];
      serviceIdToReschedule = nextAppt.appointment_service_id;
      serviceId = nextAppt.service_id;
      clientId = nextAppt.client_id;
      stylistId = stylist || nextAppt.stylist_id;
      concurrencyDigits = nextAppt.concurrency_check;
      originalStartTime = nextAppt.datetime;

      console.log('PRODUCTION: Found appointment to reschedule:', serviceIdToReschedule, 'for', nextAppt.client_name, 'from', nextAppt.datetime, 'to', new_datetime);
    } // End of phone lookup block

    // Get the appointmentId for the service we're rescheduling
    // We need to find ALL services with the same appointmentId (main + add-ons)
    const apptLookupRes = await axios.get(
      `${CONFIG.API_URL}/book/client/${clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
      { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
    );
    const allClientServices = apptLookupRes.data?.data || apptLookupRes.data || [];
    const targetService = allClientServices.find(s => s.appointmentServiceId === serviceIdToReschedule);

    if (!targetService) {
      return res.json({
        success: false,
        error: 'Could not find the appointment service'
      });
    }

    const appointmentId = targetService.appointmentId;
    console.log('PRODUCTION: Found appointmentId:', appointmentId);

    // Get ALL services for this appointment (main service + add-ons)
    const appointmentServices = allClientServices
      .filter(s => s.appointmentId === appointmentId && !s.isCancelled)
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    console.log(`PRODUCTION: Found ${appointmentServices.length} service(s) in appointment (including add-ons)`);

    // Calculate time offsets from the main (first) service
    const mainServiceStartTime = new Date(appointmentServices[0].startTime);
    const servicesWithOffsets = appointmentServices.map(s => ({
      appointment_service_id: s.appointmentServiceId,
      service_id: s.serviceId,
      stylist_id: s.employeeId,
      concurrency_check: s.concurrencyCheckDigits,
      original_start_time: s.startTime,
      offset_ms: new Date(s.startTime) - mainServiceStartTime
    }));

    // Log the services we're moving
    servicesWithOffsets.forEach((s, i) => {
      const offsetMins = s.offset_ms / 60000;
      console.log(`  Service ${i + 1}: ${s.service_id} (offset: ${offsetMins} mins)`);
    });

    const newMainStartTime = new Date(new_datetime);
    let newAppointmentServiceId = serviceIdToReschedule;
    let newAppointmentId = null;

    // If no stylist specified, find an available one for the new time
    let effectiveStylistId = stylistId;
    if (!effectiveStylistId) {
      console.log('PRODUCTION: No stylist specified, finding available stylist for new time...');
      effectiveStylistId = await findAvailableStylist(authToken, servicesWithOffsets[0].service_id, new_datetime);
      if (effectiveStylistId) {
        console.log(`PRODUCTION: Using available stylist: ${effectiveStylistId}`);
      } else {
        console.log('PRODUCTION: Could not find available stylist, will try without specifying');
      }
    }

    // Try PUT first (works for same-day time changes)
    let needsCancelRebook = false;
    const updatedServices = []; // Track services we've updated for rollback

    try {
      // Update ALL services via PUT, tracking successful updates for rollback
      for (let i = 0; i < servicesWithOffsets.length; i++) {
        const svc = servicesWithOffsets[i];
        const svcNewTime = new Date(newMainStartTime.getTime() + svc.offset_ms);
        // Format in MST (-07:00) by adjusting for timezone offset
        const mstOffset = 7 * 60 * 60 * 1000; // 7 hours in ms
        const mstTime = new Date(svcNewTime.getTime() - mstOffset);
        const svcNewTimeStr = i === 0 ? new_datetime : mstTime.toISOString().split('.')[0] + '-07:00';

        // Get fresh concurrency check
        const freshLookup = await axios.get(
          `${CONFIG.API_URL}/book/client/${clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
          { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
        );
        const freshServices = freshLookup.data?.data || freshLookup.data || [];
        const freshSvc = freshServices.find(s => s.appointmentServiceId === svc.appointment_service_id);

        if (!freshSvc) {
          throw new Error(`Service ${svc.appointment_service_id} not found`);
        }

        const updateData = new URLSearchParams({
          ServiceId: svc.service_id,
          StartTime: svcNewTimeStr,
          ClientId: clientId,
          ClientGender: 2035,
          ConcurrencyCheckDigits: freshSvc.concurrencyCheckDigits
        });
        if (effectiveStylistId) updateData.append('EmployeeId', effectiveStylistId);

        try {
          await axios.put(
            `${CONFIG.API_URL}/book/service/${svc.appointment_service_id}?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
            updateData.toString(),
            {
              headers: {
                Authorization: `Bearer ${authToken}`,
                'Content-Type': 'application/x-www-form-urlencoded'
              }
            }
          );
          // Track this successful update for potential rollback
          updatedServices.push({
            appointment_service_id: svc.appointment_service_id,
            service_id: svc.service_id,
            original_time: svc.original_start_time
          });
          console.log(`PRODUCTION: Service ${i + 1} rescheduled via PUT to ${svcNewTimeStr}`);
        } catch (svcError) {
          const errorMsg = svcError.response?.data?.error?.message || '';

          // If date change blocked, switch to cancel+rebook
          if (errorMsg.includes('When changing the date')) {
            // Rollback any services we already updated
            console.log('PRODUCTION: Date change detected, rolling back partial updates...');
            for (const updated of updatedServices) {
              const rollbackLookup = await axios.get(
                `${CONFIG.API_URL}/book/client/${clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
                { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
              );
              const rollbackServices = rollbackLookup.data?.data || rollbackLookup.data || [];
              const rollbackSvc = rollbackServices.find(s => s.appointmentServiceId === updated.appointment_service_id);
              if (rollbackSvc) {
                const rollbackData = new URLSearchParams({
                  ServiceId: updated.service_id,
                  StartTime: updated.original_time,
                  ClientId: clientId,
                  ClientGender: 2035,
                  ConcurrencyCheckDigits: rollbackSvc.concurrencyCheckDigits
                });
                if (stylistId) rollbackData.append('EmployeeId', stylistId);
                await axios.put(
                  `${CONFIG.API_URL}/book/service/${updated.appointment_service_id}?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
                  rollbackData.toString(),
                  { headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
                ).catch(e => console.log('Rollback warning:', e.message));
              }
            }
            needsCancelRebook = true;
            break; // Exit the loop, proceed to cancel+rebook
          } else {
            // Other error - rollback and throw
            console.log('PRODUCTION: Update failed, rolling back partial updates...');
            for (const updated of updatedServices) {
              const rollbackLookup = await axios.get(
                `${CONFIG.API_URL}/book/client/${clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
                { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
              );
              const rollbackServices = rollbackLookup.data?.data || rollbackLookup.data || [];
              const rollbackSvc = rollbackServices.find(s => s.appointmentServiceId === updated.appointment_service_id);
              if (rollbackSvc) {
                const rollbackData = new URLSearchParams({
                  ServiceId: updated.service_id,
                  StartTime: updated.original_time,
                  ClientId: clientId,
                  ClientGender: 2035,
                  ConcurrencyCheckDigits: rollbackSvc.concurrencyCheckDigits
                });
                if (stylistId) rollbackData.append('EmployeeId', stylistId);
                await axios.put(
                  `${CONFIG.API_URL}/book/service/${updated.appointment_service_id}?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
                  rollbackData.toString(),
                  { headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
                ).catch(e => console.log('Rollback warning:', e.message));
              }
            }
            throw svcError;
          }
        }
      }
    } catch (putError) {
      if (!needsCancelRebook) {
        throw putError;
      }
    }

    // Handle date change via cancel+rebook for ALL services
    if (needsCancelRebook) {
      console.log('PRODUCTION: Date change detected, using cancel+rebook for ALL services');
      console.log(`PRODUCTION: Will reschedule ${servicesWithOffsets.length} service(s)`);

      // Cancel ALL services in this appointment (in reverse order - add-ons first)
      // IMPORTANT: Re-fetch fresh data before EACH cancel, as cancelling one service
      // can change the concurrency check digits of other services in the same appointment
      for (let i = servicesWithOffsets.length - 1; i >= 0; i--) {
        const svc = servicesWithOffsets[i];
        console.log(`PRODUCTION: Cancelling service ${i + 1}: ${svc.appointment_service_id}`);

        // Get fresh concurrency check for THIS specific service right before cancelling
        const freshLookupForCancel = await axios.get(
          `${CONFIG.API_URL}/book/client/${clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
          { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
        );
        const freshServicesForCancel = freshLookupForCancel.data?.data || freshLookupForCancel.data || [];
        const freshSvc = freshServicesForCancel.find(s => s.appointmentServiceId === svc.appointment_service_id);

        if (freshSvc && !freshSvc.isCancelled) {
          try {
            await axios.delete(
              `${CONFIG.API_URL}/book/service/${svc.appointment_service_id}?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}&ConcurrencyCheckDigits=${freshSvc.concurrencyCheckDigits}`,
              { headers: { Authorization: `Bearer ${authToken}` } }
            );
            console.log(`PRODUCTION: Successfully cancelled service ${i + 1}: ${svc.appointment_service_id}`);
          } catch (cancelErr) {
            console.log(`Warning: Could not cancel service ${svc.appointment_service_id}:`, cancelErr.response?.data?.error?.message || cancelErr.message);
          }
        } else {
          console.log(`PRODUCTION: Skipping service ${svc.appointment_service_id} - not found or already cancelled`);
        }
      }

      // Rebook the main service first
      const mainService = servicesWithOffsets[0];

      // effectiveStylistId was already set earlier (either from request or found available)

      const bookData = new URLSearchParams({
        ServiceId: mainService.service_id,
        ClientId: clientId,
        ClientGender: 2035,
        StartTime: new_datetime
      });
      if (effectiveStylistId) bookData.append('EmployeeId', effectiveStylistId);

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
        const newMainAppt = bookRes.data?.data;
        newAppointmentServiceId = newMainAppt?.appointmentServiceId || serviceIdToReschedule;
        newAppointmentId = newMainAppt?.appointmentId;
        console.log('PRODUCTION: Main service rebooked at new time:', new_datetime);
        console.log('PRODUCTION: New appointmentId:', newAppointmentId);

        // Rebook add-on services with proper time offsets, linked to new appointment
        const rebookedServices = [{ service_id: mainService.service_id, appointment_service_id: newAppointmentServiceId }];

        for (let i = 1; i < servicesWithOffsets.length; i++) {
          const addonService = servicesWithOffsets[i];
          const addonNewTime = new Date(newMainStartTime.getTime() + addonService.offset_ms);
          // Format in MST (-07:00) by adjusting for timezone offset
          const mstOffset = 7 * 60 * 60 * 1000; // 7 hours in ms
          const mstTime = new Date(addonNewTime.getTime() - mstOffset);
          const addonNewTimeStr = mstTime.toISOString().split('.')[0] + '-07:00';

          const addonBookData = new URLSearchParams({
            ServiceId: addonService.service_id,
            ClientId: clientId,
            ClientGender: 2035,
            StartTime: addonNewTimeStr,
            AppointmentId: newAppointmentId  // Link to the new appointment
          });
          if (effectiveStylistId) addonBookData.append('EmployeeId', effectiveStylistId);

          try {
            const addonRes = await axios.post(
              `${CONFIG.API_URL}/book/service?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
              addonBookData.toString(),
              {
                headers: {
                  Authorization: `Bearer ${authToken}`,
                  'Content-Type': 'application/x-www-form-urlencoded'
                }
              }
            );
            rebookedServices.push({
              service_id: addonService.service_id,
              appointment_service_id: addonRes.data?.data?.appointmentServiceId
            });
            console.log(`PRODUCTION: Add-on service ${i} rebooked at ${addonNewTimeStr}`);
          } catch (addonErr) {
            // Add-on failed - rollback ALL rebooked services and restore originals
            console.error(`PRODUCTION: Add-on booking failed at ${addonNewTimeStr}:`, addonErr.response?.data?.error?.message || addonErr.message);
            console.log('PRODUCTION: Rolling back all rebooked services...');

            // Cancel the services we just booked
            for (const rebooked of rebookedServices) {
              if (rebooked.appointment_service_id) {
                const freshLookup = await axios.get(
                  `${CONFIG.API_URL}/book/client/${clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
                  { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
                );
                const freshSvc = (freshLookup.data?.data || []).find(s => s.appointmentServiceId === rebooked.appointment_service_id);
                if (freshSvc) {
                  await axios.delete(
                    `${CONFIG.API_URL}/book/service/${rebooked.appointment_service_id}?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}&ConcurrencyCheckDigits=${freshSvc.concurrencyCheckDigits}`,
                    { headers: { Authorization: `Bearer ${authToken}` } }
                  ).catch(e => console.log('Rollback cancel failed:', e.message));
                }
              }
            }

            // Restore original appointments
            for (const svc of servicesWithOffsets) {
              const rollbackData = new URLSearchParams({
                ServiceId: svc.service_id,
                ClientId: clientId,
                ClientGender: 2035,
                StartTime: svc.original_start_time
              });
              if (stylistId) rollbackData.append('EmployeeId', stylistId);
              await axios.post(
                `${CONFIG.API_URL}/book/service?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
                rollbackData.toString(),
                { headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
              ).catch(e => console.log('Rollback rebook failed:', e.message));
            }

            throw new Error(`Cannot reschedule: the requested time does not have availability for all services (${addonErr.response?.data?.error?.message || addonErr.message})`);
          }
        }
      } catch (bookError) {
        // Rollback - try to rebook all at original times
        console.error('PRODUCTION: Rebook failed, attempting rollback');
        for (const svc of servicesWithOffsets) {
          const rollbackData = new URLSearchParams({
            ServiceId: svc.service_id,
            ClientId: clientId,
            ClientGender: 2035,
            StartTime: svc.original_start_time
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
        }
        throw bookError;
      }
    }

    res.json({
      success: true,
      rescheduled: true,
      new_datetime: new_datetime,
      message: 'Your appointment has been rescheduled',
      appointment_service_id: newAppointmentServiceId,
      services_rescheduled: servicesWithOffsets.length
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
  service: 'Reschedule Appointment',
  version: '2.0.0',
  features: [
    'Linked profile support (minors/guests)',
    'ADD-ON PRESERVATION: Reschedules all services in appointment together',
    'Maintains time offsets between main service and add-ons'
  ]
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PRODUCTION Reschedule server running on port ${PORT}`));
